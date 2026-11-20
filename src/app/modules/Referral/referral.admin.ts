import { Prisma, ReferralStatus, RewardKind, RewardStatus } from "@prisma/client";
import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { audit, AuditCtx, auditTx } from "../../utils/audit";
import { CsvColumn, streamCsv } from "../../utils/csv";
import type { AdminContext } from "../Admin/admin.middleware";
import { can } from "../Admin/admin.permissions";
import { maskEmail, maskPhone } from "../Admin/admin.service";
import { addDays, between, dayStart, daySql, daysBetween, dhakaDay } from "../Analytics/analytics.days";
import { getReferralCost } from "../Settlement/settlement.earnings";
import { ensureCode, resetCodeTx } from "./referral.codes";
import { friendName, normalizeCode, percentToBps, rewardLabel } from "./referral.math";
import { countAfterCommit, kindDim } from "./referral.metrics";
import { notifyEarned, notifyRevoked } from "./referral.notify";
import {
  ReferralAdminQueries,
  type AdminReferralListQuery,
  type AdminRewardListQuery,
} from "./referral.validation";

/**
 * Back office for the referral program, under /admin/referrals: the overview,
 * every referral and reward, the review queue, grant / revoke, code reset and
 * block. Every write is one transaction holding its conditional update, its
 * `ReferralEvent` row and its audit row; notices go out after commit.
 *
 * Emails and phones are masked unless the caller holds `users.view_pii`, and
 * only then can `q` search by email. Money comes only from settlement.earnings.
 */

const PAGE_SIZE = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 400;
const WALK_IN_DOMAIN = "@walk-in.invalid";

const HREF = {
  user: (id: string) => `/dashboard/admin/users/${id}`,
  referral: (id: string) => `/dashboard/admin/referrals/${id}`,
  booking: (id: string) => `/dashboard/admin/bookings/${id}`,
  homeBooking: (id: string) => `/dashboard/admin/home-service/bookings/${id}`,
};

const notFound = (what = "Not found") => new ApiError(StatusCodes.NOT_FOUND, what);
const invalidState = (message: string) => ApiError.withCode(StatusCodes.CONFLICT, message, "INVALID_STATE");

const pageOf = (raw: unknown) => Math.max(1, Math.min(10_000, Number(raw) || 1));
const pageMeta = (page: number, total: number) => ({
  page,
  limit: PAGE_SIZE,
  total,
  totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
});

const piiOf = (admin: AdminContext | undefined) => !!admin && can(admin, "users.view_pii");

/** Statuses a referral can still be rejected from. */
const LIVE_REFERRAL: ReferralStatus[] = ["PENDING_VERIFICATION", "JOINED", "QUALIFIED"];

/** Plain-English reasons for the soft risk flags. */
export const FLAG_REASONS: Record<string, string> = {
  SAME_DEVICE: "Signed up on a device the referrer has used.",
  SAME_NETWORK: "Signed up from the same network (IP address) as the referrer.",
  VELOCITY: "Too many sign-ups on this code within 24 hours.",
  DISPOSABLE_EMAIL: "Signed up with a disposable email address.",
  AUTO_CLOSED: "The qualifying booking was closed by the system, not completed by the salon.",
  PHONE_REUSED: "The friend's phone number has already been used for a welcome reward.",
};

const EVENT_LABELS: Record<string, string> = {
  attached: "Signed up with the code",
  verified: "Email verified (joined)",
  "welcome.issued": "Welcome reward issued",
  reserved: "Reward reserved on a booking",
  released: "Reward released from a booking",
  redeemed: "Reward redeemed",
  consumed_no_show: "Reward used up by a no-show",
  restored_after_appeal: "Reward given back after an upheld appeal",
  expired: "Expired",
  qualified: "Referral qualified",
  "referrer.issued": "Referrer reward issued",
  "referrer.skipped": "No referrer reward",
  flagged: "Flagged for review",
  approved: "Approved by an admin",
  rejected: "Rejected by an admin",
  revoked: "Reward revoked",
  granted: "Reward granted by an admin",
  code_reset: "Code reset",
  blocked: "Blocked from the program",
  unblocked: "Unblocked",
};

const flagsOf = (flags: string[]) => flags.map((flag) => ({ flag, reason: FLAG_REASONS[flag] ?? flag }));

type Person = { id: string; name: string; email: string; phone?: string | null };
const personOf = (u: Person, pii: boolean) => ({
  id: u.id,
  name: u.name,
  email: pii ? u.email : maskEmail(u.email),
  ...(u.phone !== undefined ? { phone: pii ? u.phone : maskPhone(u.phone) } : {}),
  href: HREF.user(u.id),
});

// ---------------------------------------------------------------------------
// Ranges and filters
// ---------------------------------------------------------------------------

/** Asia/Dhaka days, `to` capped at today; the default is the last 30 days. */
const parseDays = (q: { from?: string; to?: string }) => {
  const today = dhakaDay();
  const to = q.to && q.to < today ? q.to : today;
  const from = q.from ?? addDays(to, -29);
  if (from > to) throw new ApiError(StatusCodes.BAD_REQUEST, "from must be on or before to");
  if (daysBetween(from, to).length > MAX_DAYS) {
    throw new ApiError(StatusCodes.BAD_REQUEST, `At most ${MAX_DAYS} days per range`);
  }
  return { from, to, start: dayStart(from), end: dayStart(addDays(to, 1)) };
};

/** [from 00:00, to 24:00) Dhaka, either side optional. */
const createdWindow = (from?: string, to?: string) =>
  from || to
    ? { ...(from && { gte: dayStart(from) }), ...(to && { lt: dayStart(addDays(to, 1)) }) }
    : undefined;

const nameOrEmail = (text: string, pii: boolean): Prisma.UserWhereInput => ({
  OR: [
    { name: { contains: text, mode: "insensitive" } },
    ...(pii ? [{ email: { contains: text, mode: "insensitive" as const } }] : []),
  ],
});

const codeMatch = (text: string): Prisma.ReferralWhereInput[] => {
  const exact = normalizeCode(text);
  const loose = text.toUpperCase().replace(/[\s-]/g, "");
  return [
    ...(exact ? [{ code: exact }] : []),
    ...(loose.length >= 3 ? [{ code: { contains: loose } }] : []),
  ];
};

const referralWhere = (q: AdminReferralListQuery, pii: boolean): Prisma.ReferralWhereInput => {
  const and: Prisma.ReferralWhereInput[] = [];
  if (q.status) and.push({ status: q.status });
  if (q.flagged === true) and.push({ NOT: { riskFlags: { isEmpty: true } } });
  if (q.flagged === false) and.push({ riskFlags: { isEmpty: true } });
  if (!q.includeTest) and.push({ isTest: false });
  const created = createdWindow(q.from, q.to);
  if (created) and.push({ createdAt: created });
  if (q.q) {
    and.push({
      OR: [
        ...codeMatch(q.q),
        { id: q.q },
        { referrer: nameOrEmail(q.q, pii) },
        { referee: nameOrEmail(q.q, pii) },
      ],
    });
  }
  return and.length ? { AND: and } : {};
};

const realRewards: Prisma.ReferralRewardWhereInput = {
  user: { isTest: false },
  OR: [{ referralId: null }, { referral: { isTest: false } }],
};

const rewardWhere = (q: AdminRewardListQuery, pii: boolean): Prisma.ReferralRewardWhereInput => {
  const and: Prisma.ReferralRewardWhereInput[] = [];
  if (q.kind) and.push({ kind: q.kind });
  if (q.status) and.push({ status: q.status });
  if (!q.includeTest) and.push(realRewards);
  if (q.q) {
    and.push({
      OR: [
        { id: q.q },
        { user: nameOrEmail(q.q, pii) },
        ...codeMatch(q.q).map((c) => ({ referral: c })),
      ],
    });
  }
  return and.length ? { AND: and } : {};
};

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

const round1 = (n: number) => Math.round(n * 10) / 10;

/** GET /admin/referrals/overview?from&to&includeTest */
export const overview = async (rawQuery: unknown) => {
  const q = ReferralAdminQueries.overview.parse(rawQuery);
  const r = parseDays(q);
  const includeTest = q.includeTest;
  const range = { gte: r.start, lt: r.end };
  const realRef: Prisma.ReferralWhereInput = includeTest ? {} : { isTest: false };
  const realRew: Prisma.ReferralRewardWhereInput = includeTest ? {} : realRewards;
  const refTest = includeTest ? Prisma.empty : Prisma.sql`AND rf."isTest" = false`;
  const salonTest = includeTest ? Prisma.empty : Prisma.sql`AND s."isTest" = false`;

  const [
    attached,
    joined,
    qualified,
    joinedThenQualified,
    rewardsIssued,
    redeemed,
    expired,
    pendingReview,
    rewarded,
    linkOpens,
    firstBookings,
    referredGmv,
    cost,
    attachedByDay,
    qualifiedByDay,
    topQualified,
    topRewards,
  ] = await Promise.all([
    prisma.referral.count({ where: { createdAt: range, ...realRef } }),
    prisma.referral.count({ where: { joinedAt: range, ...realRef } }),
    prisma.referral.count({ where: { qualifiedAt: range, ...realRef } }),
    // Cohort: of the friends who joined in the range, how many qualified (so far).
    prisma.referral.count({ where: { joinedAt: range, qualifiedAt: { not: null }, ...realRef } }),
    prisma.referralReward.count({ where: { createdAt: range, ...realRew } }),
    // Spent on a completed booking (a no-show using one up is not a redemption).
    prisma.referralEvent.count({
      where: { type: "redeemed", createdAt: range, ...(includeTest ? {} : { reward: { is: realRewards } }) },
    }),
    // EXPIRED is final, so its last update is when it expired.
    prisma.referralReward.count({ where: { status: RewardStatus.EXPIRED, updatedAt: range, ...realRew } }),
    // The queue as it stands now; the range does not apply.
    prisma.referralReward.count({ where: { status: RewardStatus.PENDING_REVIEW, ...realRew } }),
    prisma.referralReward.count({ where: { kind: RewardKind.REFERRER_BONUS, createdAt: range, ...realRew } }),
    // Tracking events carry no test flag (contract 10). Stays 0 until the
    // landing page sends referral_landing_view (frontend phase).
    prisma.$queryRaw<Array<{ n: number }>>`
      SELECT COALESCE(SUM(count), 0)::int AS n FROM event_daily
      WHERE event = 'referral_landing_view' AND dimension = 'state:valid'
        AND day >= ${r.from}::date AND day <= ${r.to}::date`,
    // Friends whose first completed booking (salon or home) falls in the range.
    // appointments.completedAt is a UTC timestamp, home_bookings' a timestamptz.
    prisma.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM (
        SELECT LEAST(
          (SELECT MIN(a."completedAt" AT TIME ZONE 'UTC') FROM appointments a
            WHERE a."customerId" = rf."refereeId" AND a.status = 'COMPLETED'),
          (SELECT MIN(h."completedAt") FROM home_bookings h
            WHERE h."customerId" = rf."refereeId" AND h.status = 'COMPLETED')
        ) AS first_at
        FROM referrals rf WHERE true ${refTest}
      ) x
      WHERE x.first_at >= ${r.start.toISOString()}::timestamptz AND x.first_at < ${r.end.toISOString()}::timestamptz`,
    // Completed billable of bookings by referred friends: salon total − counter
    // discount (as GMV), home subtotal (services only, as qualification uses).
    prisma.$queryRaw<Array<{ v: number }>>`
      SELECT COALESCE(SUM(v), 0)::float AS v FROM (
        SELECT (a."totalMinor" - a."discountMinor") AS v
        FROM appointments a
        JOIN referrals rf ON rf."refereeId" = a."customerId"
        JOIN salons s ON s.id = a."salonId"
        WHERE a.status = 'COMPLETED' AND ${between(`COALESCE(a."completedAt", a."appointmentDate")`, r.start, r.end)}
          ${refTest} ${salonTest}
        UNION ALL
        SELECT h."subtotalMinor" AS v
        FROM home_bookings h
        JOIN referrals rf ON rf."refereeId" = h."customerId"
        JOIN salons s ON s.id = h."salonId"
        WHERE h.status = 'COMPLETED'
          AND h."completedAt" >= ${r.start.toISOString()}::timestamptz AND h."completedAt" < ${r.end.toISOString()}::timestamptz
          ${refTest} ${salonTest}
      ) x`,
    getReferralCost({ from: r.start, to: r.end, includeTest }),
    prisma.$queryRaw<Array<{ day: string; n: number }>>`
      SELECT ${daySql(`rf."createdAt"`)} AS day, COUNT(*)::int AS n FROM referrals rf
      WHERE ${between(`rf."createdAt"`, r.start, r.end)} ${refTest} GROUP BY 1`,
    prisma.$queryRaw<Array<{ day: string; n: number }>>`
      SELECT ${daySql(`rf."qualifiedAt"`)} AS day, COUNT(*)::int AS n FROM referrals rf
      WHERE rf."qualifiedAt" IS NOT NULL AND ${between(`rf."qualifiedAt"`, r.start, r.end)} ${refTest} GROUP BY 1`,
    prisma.referral.groupBy({
      by: ["referrerId"],
      where: { qualifiedAt: range, ...realRef },
      _count: { _all: true },
    }),
    prisma.referralReward.groupBy({
      by: ["userId"],
      where: { kind: RewardKind.REFERRER_BONUS, createdAt: range, ...realRew },
      _count: { _all: true },
    }),
  ]);

  const discountCostMinor = cost.costMinor;

  // Daily series over every day of the range, zeros included.
  const attachedOn = new Map(attachedByDay.map((d) => [d.day, d.n]));
  const qualifiedOn = new Map(qualifiedByDay.map((d) => [d.day, d.n]));
  const costOn = new Map(cost.byDay.map((d) => [d.day, d.costMinor]));
  const daily = daysBetween(r.from, r.to).map((day) => ({
    day,
    attached: attachedOn.get(day) ?? 0,
    qualified: qualifiedOn.get(day) ?? 0,
    costMinor: costOn.get(day) ?? 0,
  }));

  // Top referrers: by qualified friends, then by cost.
  const tally = new Map<string, { qualified: number; rewards: number; costMinor: number }>();
  const at = (id: string) => {
    let t = tally.get(id);
    if (!t) tally.set(id, (t = { qualified: 0, rewards: 0, costMinor: 0 }));
    return t;
  };
  for (const g of topQualified) at(g.referrerId).qualified = g._count._all;
  for (const g of topRewards) at(g.userId).rewards = g._count._all;
  for (const c of cost.byReferrer) at(c.referrerId).costMinor = c.costMinor;
  const top = [...tally.entries()]
    .sort((a, b) => b[1].qualified - a[1].qualified || b[1].costMinor - a[1].costMinor || b[1].rewards - a[1].rewards)
    .slice(0, 10);
  const names = top.length
    ? new Map(
        (await prisma.user.findMany({ where: { id: { in: top.map(([id]) => id) } }, select: { id: true, name: true } })).map(
          (u) => [u.id, u.name],
        ),
      )
    : new Map<string, string>();

  const firstBooked = firstBookings[0]?.n ?? 0;
  return {
    range: { from: r.from, to: r.to },
    includeTest,
    kpis: {
      attached,
      joined,
      qualified,
      conversionPercent: joined > 0 ? round1((joinedThenQualified / joined) * 100) : 0,
      rewardsIssued,
      rewardsRedeemed: redeemed,
      rewardsExpired: expired,
      pendingReview,
      discountCostMinor,
      costPerQualifiedMinor: qualified > 0 ? Math.round(discountCostMinor / qualified) : 0,
      referredGmvMinor: Number(referredGmv[0]?.v ?? 0),
    },
    funnel: [
      { key: "link_opens", label: "Invite link opened", count: linkOpens[0]?.n ?? 0 },
      { key: "signups", label: "Signed up with a code", count: attached },
      { key: "verified", label: "Email verified", count: joined },
      { key: "first_booking", label: "First booking completed", count: firstBooked },
      { key: "rewarded", label: "Referrer rewarded", count: rewarded },
    ],
    daily,
    costByKind: cost.byKind,
    topReferrers: top.map(([id, t]) => ({
      userId: id,
      name: friendName(names.get(id) ?? ""),
      href: HREF.user(id),
      qualified: t.qualified,
      rewards: t.rewards,
      costMinor: t.costMinor,
    })),
  };
};

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

const userSelect = { id: true, name: true, email: true } as const;

/** GET /admin/referrals */
export const listReferrals = async (admin: AdminContext | undefined, rawQuery: unknown) => {
  const q = ReferralAdminQueries.list.parse(rawQuery);
  const pii = piiOf(admin);
  const page = pageOf(q.page);
  const where = referralWhere(q, pii);
  const [total, rows] = await Promise.all([
    prisma.referral.count({ where }),
    prisma.referral.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        referrer: { select: userSelect },
        referee: { select: userSelect },
        rewards: { select: { id: true, kind: true, status: true, percentBps: true, expiresAt: true } },
      },
    }),
  ]);
  return {
    meta: { ...pageMeta(page, total), piiMasked: !pii },
    data: rows.map((r) => ({
      id: r.id,
      code: r.code,
      channel: r.channel,
      status: r.status,
      riskFlags: r.riskFlags,
      heldForReview: r.rewards.some((w) => w.status === RewardStatus.PENDING_REVIEW),
      referrerRewardSkip: r.referrerRewardSkip,
      createdAt: r.createdAt,
      joinedAt: r.joinedAt,
      qualifiedAt: r.qualifiedAt,
      isTest: r.isTest,
      referrer: personOf(r.referrer, pii),
      referee: personOf(r.referee, pii),
      rewards: r.rewards.map((w) => ({ ...w, label: rewardLabel(w.kind, w.percentBps) })),
      href: HREF.referral(r.id),
    })),
  };
};

const detailUserSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  status: true,
  emailVerified: true,
  isTest: true,
  isDeleted: true,
  createdAt: true,
  referralCode: { select: { code: true, blockedAt: true, blockedReason: true } },
} satisfies Prisma.UserSelect;

type DetailUser = Prisma.UserGetPayload<{ select: typeof detailUserSelect }>;

const detailPerson = (u: DetailUser, pii: boolean) => ({
  ...personOf(u, pii),
  role: u.role,
  status: u.status,
  emailVerified: u.emailVerified,
  isTest: u.isTest,
  isDeleted: u.isDeleted,
  joinedAt: u.createdAt,
  code: u.referralCode?.code ?? null,
  codeBlocked: !!u.referralCode?.blockedAt,
  codeBlockedReason: u.referralCode?.blockedReason ?? null,
});

/** Appointments and home visits by id, for links. */
const bookingRefs = async (appointmentIds: string[], homeIds: string[]) => {
  const [appointments, homes] = await Promise.all([
    appointmentIds.length
      ? prisma.appointment.findMany({
          where: { id: { in: appointmentIds } },
          select: {
            id: true,
            token: true,
            status: true,
            completedAt: true,
            totalMinor: true,
            discountMinor: true,
            promoDiscountMinor: true,
            source: true,
            salon: { select: { id: true, name: true } },
          },
        })
      : [],
    homeIds.length
      ? prisma.homeBooking.findMany({
          where: { id: { in: homeIds } },
          select: {
            id: true,
            code: true,
            status: true,
            completedAt: true,
            subtotalMinor: true,
            promoDiscountMinor: true,
            salon: { select: { id: true, name: true } },
          },
        })
      : [],
  ]);
  const map = new Map<string, Record<string, unknown>>();
  for (const a of appointments) {
    map.set(a.id, {
      kind: "SALON",
      id: a.id,
      reference: a.token,
      status: a.status,
      completedAt: a.completedAt,
      billableMinor: a.totalMinor - a.discountMinor,
      promoDiscountMinor: a.promoDiscountMinor,
      source: a.source,
      salon: a.salon,
      href: HREF.booking(a.id),
    });
  }
  for (const h of homes) {
    map.set(h.id, {
      kind: "HOME",
      id: h.id,
      reference: h.code,
      status: h.status,
      completedAt: h.completedAt,
      billableMinor: h.subtotalMinor,
      promoDiscountMinor: h.promoDiscountMinor,
      salon: h.salon,
      href: HREF.homeBooking(h.id),
    });
  }
  return (id: string | null | undefined, kind: "SALON" | "HOME") =>
    id ? (map.get(id) ?? { kind, id, reference: null, status: "MISSING", href: null }) : null;
};

type RewardRow = Prisma.ReferralRewardGetPayload<object>;

const rewardView = (w: RewardRow, booking: ReturnType<Awaited<ReturnType<typeof bookingRefs>>>) => ({
  id: w.id,
  kind: w.kind,
  label: rewardLabel(w.kind, w.percentBps),
  status: w.status,
  percent: w.percentBps / 100,
  percentBps: w.percentBps,
  maxDiscountMinor: w.maxDiscountMinor,
  minOrderMinor: w.minOrderMinor,
  scope: w.scope,
  firstBookingOnly: w.firstBookingOnly,
  expiresAt: w.expiresAt,
  discountMinor: w.discountMinor,
  createdAt: w.createdAt,
  reservedAt: w.reservedAt,
  redeemedAt: w.redeemedAt,
  revokedAt: w.revokedAt,
  revokeReason: w.revokeReason,
  expiredReason: w.expiredReason,
  grantReason: w.grantReason,
  remindedAt: w.remindedAt,
  booking,
});

/** GET /admin/referrals/:id */
export const getReferral = async (admin: AdminContext | undefined, id: string) => {
  const pii = piiOf(admin);
  const r = await prisma.referral.findUnique({
    where: { id },
    include: {
      referrer: { select: detailUserSelect },
      referee: { select: detailUserSelect },
      rewards: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!r) throw notFound("Referral not found");

  const rewardIds = r.rewards.map((w) => w.id);
  const events = await prisma.referralEvent.findMany({
    where: { OR: [{ referralId: id }, ...(rewardIds.length ? [{ rewardId: { in: rewardIds } }] : [])] },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const actorIds = [...new Set(events.map((e) => e.actorId).filter((a): a is string => !!a))];
  const actors = actorIds.length
    ? new Map((await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]))
    : new Map<string, string>();

  const booking = await bookingRefs(
    [r.qualifyingAppointmentId, ...r.rewards.map((w) => w.appointmentId)].filter((x): x is string => !!x),
    [r.qualifyingHomeBookingId, ...r.rewards.map((w) => w.homeBookingId)].filter((x): x is string => !!x),
  );
  const rewardBooking = (w: RewardRow) =>
    w.appointmentId ? booking(w.appointmentId, "SALON") : booking(w.homeBookingId, "HOME");
  const welcome = r.rewards.find((w) => w.kind === RewardKind.REFEREE_WELCOME) ?? null;
  const bonus = r.rewards.find((w) => w.kind === RewardKind.REFERRER_BONUS) ?? null;

  return {
    id: r.id,
    code: r.code,
    channel: r.channel,
    status: r.status,
    isTest: r.isTest,
    createdAt: r.createdAt,
    joinedAt: r.joinedAt,
    qualifiedAt: r.qualifiedAt,
    referrerRewardSkip: r.referrerRewardSkip,
    reviewedById: r.reviewedById,
    reviewedAt: r.reviewedAt,
    reviewNote: r.reviewNote,
    rejectedReason: r.rejectedReason,
    piiMasked: !pii,
    flags: flagsOf(r.riskFlags),
    referrer: detailPerson(r.referrer, pii),
    referee: detailPerson(r.referee, pii),
    qualifyingBooking: r.qualifyingAppointmentId
      ? booking(r.qualifyingAppointmentId, "SALON")
      : booking(r.qualifyingHomeBookingId, "HOME"),
    rewards: {
      welcome: welcome && rewardView(welcome, rewardBooking(welcome)),
      referrer: bonus && rewardView(bonus, rewardBooking(bonus)),
    },
    // Decisions available on this referral, so the page shows the right buttons.
    canApprove: bonus?.status === RewardStatus.PENDING_REVIEW,
    canReject: LIVE_REFERRAL.includes(r.status),
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      label: EVENT_LABELS[e.type] ?? e.type,
      createdAt: e.createdAt,
      rewardId: e.rewardId,
      actor: e.actorId ? { id: e.actorId, name: actors.get(e.actorId) ?? null } : null,
      data: e.data,
    })),
  };
};

/** POST /admin/referrals/:id/approve - the held referrer reward is released. */
export const approveReferral = async (ctx: AuditCtx | undefined, id: string, note?: string) => {
  const actorId = ctx?.actorUserId ?? null;
  const result = await prisma.$transaction(async (tx) => {
    const referral = await tx.referral.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!referral) throw notFound("Referral not found");
    const reward = await tx.referralReward.findFirst({
      where: { referralId: id, kind: RewardKind.REFERRER_BONUS, status: RewardStatus.PENDING_REVIEW },
    });
    if (!reward) throw invalidState("This referral has no reward waiting for review.");

    // The reward keeps its own validity, counted from the approval.
    const now = new Date();
    const validMs = Math.max(reward.expiresAt.getTime() - reward.createdAt.getTime(), DAY_MS);
    const expiresAt = new Date(now.getTime() + validMs);
    const { count } = await tx.referralReward.updateMany({
      where: { id: reward.id, status: RewardStatus.PENDING_REVIEW },
      data: { status: RewardStatus.AVAILABLE, expiresAt },
    });
    if (count === 0) throw invalidState("This reward was decided a moment ago. Reload to see it.");

    await tx.referral.update({
      where: { id },
      data: { reviewedById: actorId, reviewedAt: now, reviewNote: note ?? null },
    });
    await tx.referralEvent.create({
      data: { referralId: id, rewardId: reward.id, type: "approved", actorId, data: { expiresAt: expiresAt.toISOString(), note: note ?? null } },
    });
    await auditTx(tx, ctx, {
      action: "referral.approve",
      entityType: "referral",
      entityId: id,
      before: { rewardId: reward.id, rewardStatus: reward.status, expiresAt: reward.expiresAt },
      after: { rewardId: reward.id, rewardStatus: RewardStatus.AVAILABLE, expiresAt },
      reason: note ?? null,
    });
    return { referralId: id, rewardId: reward.id, rewardStatus: RewardStatus.AVAILABLE, expiresAt };
  });
  void notifyEarned(result.rewardId);
  return result;
};

/**
 * Referrals moved to REJECTED with their held (PENDING_REVIEW) rewards
 * REVOKED, with events. A reward already redeemed is never clawed back, and an
 * AVAILABLE one is left alone (revoke it on its own if needed).
 */
const rejectInTx = async (
  tx: Prisma.TransactionClient,
  referralIds: string[],
  actorId: string | null,
  reason: string,
) => {
  if (!referralIds.length) return { rejected: [] as string[], revoked: [] as string[] };
  const now = new Date();
  const live = await tx.referral.findMany({
    where: { id: { in: referralIds }, status: { in: LIVE_REFERRAL } },
    select: { id: true, status: true },
  });
  const rejected: string[] = [];
  for (const r of live) {
    const { count } = await tx.referral.updateMany({
      where: { id: r.id, status: { in: LIVE_REFERRAL } },
      data: { status: ReferralStatus.REJECTED, rejectedReason: reason, reviewedById: actorId, reviewedAt: now },
    });
    if (count === 0) continue;
    rejected.push(r.id);
    await tx.referralEvent.create({
      data: { referralId: r.id, type: "rejected", actorId, data: { from: r.status, reason } },
    });
  }

  const held = await tx.referralReward.findMany({
    where: { referralId: { in: referralIds }, status: RewardStatus.PENDING_REVIEW },
    select: { id: true, referralId: true },
  });
  const revoked: string[] = [];
  for (const w of held) {
    const { count } = await tx.referralReward.updateMany({
      where: { id: w.id, status: RewardStatus.PENDING_REVIEW },
      data: { status: RewardStatus.REVOKED, revokedAt: now, revokedById: actorId, revokeReason: reason },
    });
    if (count === 0) continue;
    revoked.push(w.id);
    await tx.referralEvent.create({
      data: { referralId: w.referralId, rewardId: w.id, type: "revoked", actorId, data: { from: RewardStatus.PENDING_REVIEW, reason } },
    });
  }
  return { rejected, revoked };
};

/** POST /admin/referrals/:id/reject { reason } */
export const rejectReferral = async (ctx: AuditCtx | undefined, id: string, reason: string) => {
  const actorId = ctx?.actorUserId ?? null;
  const result = await prisma.$transaction(async (tx) => {
    const referral = await tx.referral.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!referral) throw notFound("Referral not found");
    if (!LIVE_REFERRAL.includes(referral.status)) {
      throw invalidState(`This referral is already ${referral.status.toLowerCase()}.`);
    }
    const out = await rejectInTx(tx, [id], actorId, reason);
    if (!out.rejected.length) throw invalidState("This referral was decided a moment ago. Reload to see it.");
    await auditTx(tx, ctx, {
      action: "referral.reject",
      entityType: "referral",
      entityId: id,
      before: { status: referral.status },
      after: { status: ReferralStatus.REJECTED, revokedRewardIds: out.revoked },
      reason,
    });
    return { referralId: id, status: ReferralStatus.REJECTED, revokedRewardIds: out.revoked };
  });
  for (const rewardId of result.revokedRewardIds) void notifyRevoked(rewardId);
  return result;
};

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

/** GET /admin/referrals/rewards */
export const listRewards = async (admin: AdminContext | undefined, rawQuery: unknown) => {
  const q = ReferralAdminQueries.rewards.parse(rawQuery);
  const pii = piiOf(admin);
  const page = pageOf(q.page);
  const where = rewardWhere(q, pii);
  const [total, rows] = await Promise.all([
    prisma.referralReward.count({ where }),
    prisma.referralReward.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { user: { select: userSelect }, referral: { select: { id: true, code: true } } },
    }),
  ]);
  const booking = await bookingRefs(
    rows.map((w) => w.appointmentId).filter((x): x is string => !!x),
    rows.map((w) => w.homeBookingId).filter((x): x is string => !!x),
  );
  return {
    meta: { ...pageMeta(page, total), piiMasked: !pii },
    data: rows.map((w) => ({
      ...rewardView(w, w.appointmentId ? booking(w.appointmentId, "SALON") : booking(w.homeBookingId, "HOME")),
      user: personOf(w.user, pii),
      referral: w.referral && { id: w.referral.id, code: w.referral.code, href: HREF.referral(w.referral.id) },
      canRevoke: w.status === RewardStatus.AVAILABLE || w.status === RewardStatus.PENDING_REVIEW,
    })),
  };
};

/** POST /admin/referrals/rewards/:id/revoke { reason } - AVAILABLE / PENDING_REVIEW only. */
export const revokeReward = async (ctx: AuditCtx | undefined, id: string, reason: string) => {
  const actorId = ctx?.actorUserId ?? null;
  const revocable: RewardStatus[] = [RewardStatus.AVAILABLE, RewardStatus.PENDING_REVIEW];
  const result = await prisma.$transaction(async (tx) => {
    const reward = await tx.referralReward.findUnique({ where: { id } });
    if (!reward) throw notFound("Reward not found");
    if (!revocable.includes(reward.status)) {
      throw invalidState(`Only an available or held reward can be revoked; this one is ${reward.status.toLowerCase().replace("_", " ")}.`);
    }
    const now = new Date();
    const { count } = await tx.referralReward.updateMany({
      where: { id, status: { in: revocable } },
      data: { status: RewardStatus.REVOKED, revokedAt: now, revokedById: actorId, revokeReason: reason },
    });
    if (count === 0) throw invalidState("This reward changed a moment ago. Reload to see it.");
    await tx.referralEvent.create({
      data: { referralId: reward.referralId, rewardId: id, type: "revoked", actorId, data: { from: reward.status, reason } },
    });
    await auditTx(tx, ctx, {
      action: "referral.reward_revoke",
      entityType: "referral_reward",
      entityId: id,
      before: { status: reward.status },
      after: { status: RewardStatus.REVOKED },
      reason,
    });
    return { rewardId: id, status: RewardStatus.REVOKED };
  });
  void notifyRevoked(id);
  return result;
};

/** A customer account an admin may act on in the program (404 for anything else). */
const loadCustomer = async (tx: Prisma.TransactionClient, userId: string) => {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, status: true, email: true, isDeleted: true },
  });
  if (!user || user.isDeleted) throw notFound("User not found");
  if (user.role !== "CUSTOMER" || user.email.toLowerCase().endsWith(WALK_IN_DOMAIN)) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Only customer accounts take part in the referral program.");
  }
  return user;
};

/** POST /admin/referrals/rewards/grant - a MANUAL_GRANT reward for one customer. */
export const grantReward = async (
  ctx: AuditCtx | undefined,
  body: { userId: string; percent: number; maxDiscountMinor: number; validDays: number; scope: "ALL" | "SALON" | "HOME"; reason: string },
) => {
  const actorId = ctx?.actorUserId ?? null;
  const result = await prisma.$transaction(async (tx) => {
    const user = await loadCustomer(tx, body.userId);
    if (user.status !== "ACTIVE") {
      throw new ApiError(StatusCodes.BAD_REQUEST, "This account is not active, so it cannot be given a reward.");
    }
    const expiresAt = new Date(Date.now() + body.validDays * DAY_MS);
    const reward = await tx.referralReward.create({
      data: {
        userId: user.id,
        referralId: null,
        kind: RewardKind.MANUAL_GRANT,
        status: RewardStatus.AVAILABLE,
        percentBps: percentToBps(body.percent),
        maxDiscountMinor: body.maxDiscountMinor,
        minOrderMinor: 0,
        scope: body.scope,
        firstBookingOnly: false,
        expiresAt,
        grantedById: actorId,
        grantReason: body.reason,
      },
    });
    const ev = await tx.referralEvent.create({
      data: {
        rewardId: reward.id,
        type: "granted",
        actorId,
        data: {
          userId: user.id,
          percentBps: reward.percentBps,
          maxDiscountMinor: reward.maxDiscountMinor,
          scope: reward.scope,
          expiresAt: expiresAt.toISOString(),
          reason: body.reason,
        },
      },
    });
    await auditTx(tx, ctx, {
      action: "referral.reward_grant",
      entityType: "referral_reward",
      entityId: reward.id,
      before: null,
      after: {
        userId: user.id,
        status: RewardStatus.AVAILABLE,
        percent: body.percent,
        maxDiscountMinor: body.maxDiscountMinor,
        validDays: body.validDays,
        scope: body.scope,
        expiresAt,
      },
      reason: body.reason,
    });
    countAfterCommit(ev.id, [{ metric: "rewards_issued", dimension: kindDim(RewardKind.MANUAL_GRANT) }]);
    return rewardView(reward, null);
  });
  void notifyEarned(result.id);
  return result;
};

// ---------------------------------------------------------------------------
// Codes and blocks
// ---------------------------------------------------------------------------

/** POST /admin/referrals/users/:userId/code/reset - the old code stops working. */
export const adminResetCode = async (ctx: AuditCtx | undefined, userId: string, reason?: string) =>
  prisma.$transaction(async (tx) => {
    await loadCustomer(tx, userId);
    const { before, row } = await resetCodeTx(tx, userId, ctx?.actorUserId ?? null);
    await auditTx(tx, ctx, {
      action: "referral.code_reset",
      entityType: "user",
      entityId: userId,
      before: { code: before },
      after: { code: row.code },
      reason: reason ?? null,
    });
    return { userId, code: row.code, blocked: !!row.blockedAt };
  });

/**
 * POST /admin/referrals/users/:userId/block { reason }: the code stops working
 * (lookups and attaches refuse it, the referrer becomes ineligible at
 * qualify), and their held referrer rewards are rejected with it.
 */
export const blockUser = async (ctx: AuditCtx | undefined, userId: string, reason: string) => {
  const actorId = ctx?.actorUserId ?? null;
  const result = await prisma.$transaction(async (tx) => {
    await loadCustomer(tx, userId);
    const code = await ensureCode(userId, tx);
    if (code.blockedAt) throw invalidState("This customer is already blocked from the referral program.");
    const now = new Date();
    const { count } = await tx.referralCode.updateMany({
      where: { userId, blockedAt: null },
      data: { blockedAt: now, blockedReason: reason },
    });
    if (count === 0) throw invalidState("This customer was blocked a moment ago. Reload to see it.");
    await tx.referralEvent.create({ data: { type: "blocked", actorId, data: { userId, code: code.code, reason } } });

    const held = await tx.referralReward.findMany({
      where: { userId, kind: RewardKind.REFERRER_BONUS, status: RewardStatus.PENDING_REVIEW },
      select: { referralId: true },
    });
    const out = await rejectInTx(
      tx,
      held.map((h) => h.referralId).filter((x): x is string => !!x),
      actorId,
      `Referrer blocked: ${reason}`,
    );
    await auditTx(tx, ctx, {
      action: "referral.block",
      entityType: "user",
      entityId: userId,
      before: { blockedAt: null },
      after: { blockedAt: now, rejectedReferralIds: out.rejected, revokedRewardIds: out.revoked },
      reason,
    });
    return { userId, blocked: true, blockedAt: now, rejectedReferralIds: out.rejected, revokedRewardIds: out.revoked };
  });
  for (const rewardId of result.revokedRewardIds) void notifyRevoked(rewardId);
  return result;
};

/** POST /admin/referrals/users/:userId/unblock */
export const unblockUser = async (ctx: AuditCtx | undefined, userId: string, reason?: string) =>
  prisma.$transaction(async (tx) => {
    const code = await tx.referralCode.findUnique({ where: { userId } });
    if (!code) throw notFound("This customer has no referral code");
    if (!code.blockedAt) throw invalidState("This customer is not blocked from the referral program.");
    const { count } = await tx.referralCode.updateMany({
      where: { userId, blockedAt: { not: null } },
      data: { blockedAt: null, blockedReason: null },
    });
    if (count === 0) throw invalidState("This customer was unblocked a moment ago. Reload to see it.");
    await tx.referralEvent.create({
      data: { type: "unblocked", actorId: ctx?.actorUserId ?? null, data: { userId, code: code.code, reason: reason ?? null } },
    });
    await auditTx(tx, ctx, {
      action: "referral.unblock",
      entityType: "user",
      entityId: userId,
      before: { blockedAt: code.blockedAt, blockedReason: code.blockedReason },
      after: { blockedAt: null },
      reason: reason ?? null,
    });
    return { userId, blocked: false };
  });

// ---------------------------------------------------------------------------
// User 360 and the inbox
// ---------------------------------------------------------------------------

/** The `referral` block of User 360 (shown with referrals.view). */
export const user360Referral = async (userId: string) => {
  const now = new Date();
  const [code, referredBy, made, qualified, available, redeemed, savedSalon, savedHome] = await Promise.all([
    prisma.referralCode.findUnique({ where: { userId }, select: { code: true, blockedAt: true, blockedReason: true } }),
    prisma.referral.findUnique({
      where: { refereeId: userId },
      select: { id: true, status: true, referrer: { select: { id: true, name: true } } },
    }),
    prisma.referral.count({ where: { referrerId: userId } }),
    prisma.referral.count({ where: { referrerId: userId, status: ReferralStatus.QUALIFIED } }),
    prisma.referralReward.count({ where: { userId, status: RewardStatus.AVAILABLE, expiresAt: { gt: now } } }),
    prisma.referralReward.count({ where: { userId, status: RewardStatus.REDEEMED } }),
    // What the customer actually saved: the promo on bookings they completed.
    prisma.appointment.aggregate({ where: { customerId: userId, status: "COMPLETED" }, _sum: { promoDiscountMinor: true } }),
    prisma.homeBooking.aggregate({ where: { customerId: userId, status: "COMPLETED" }, _sum: { promoDiscountMinor: true } }),
  ]);
  return {
    code: code?.code ?? null,
    blocked: !!code?.blockedAt,
    blockedReason: code?.blockedReason ?? null,
    referredBy: referredBy
      ? { id: referredBy.referrer.id, name: referredBy.referrer.name, referralId: referredBy.id, status: referredBy.status }
      : null,
    made: { total: made, qualified },
    rewards: {
      available,
      redeemed,
      savedMinor: (savedSalon._sum.promoDiscountMinor ?? 0) + (savedHome._sum.promoDiscountMinor ?? 0),
    },
  };
};

/** Inbox `referrals.review`: referrals whose referrer reward waits for a decision. */
export const reviewQueue = async () => {
  const agg = await prisma.referralReward.aggregate({
    where: { status: RewardStatus.PENDING_REVIEW, referralId: { not: null } },
    _count: { _all: true },
    _min: { createdAt: true },
  });
  return { count: agg._count._all, oldestAt: agg._min.createdAt };
};

// ---------------------------------------------------------------------------
// CSV export (outside the envelope; errors before streaming still use it)
// ---------------------------------------------------------------------------

type Keyed = { id: string; createdAt: Date };

const keyset = (after: Keyed | undefined, take: number) => ({
  take,
  orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
  ...(after && { cursor: { id: after.id }, skip: 1 }),
});

/** GET /admin/referrals/export?type=referrals|rewards&…filters (referrals.view + analytics.export). */
export const exportCsv = async (req: Request, res: Response) => {
  const { type } = ReferralAdminQueries.exportType.parse(req.query);
  const pii = piiOf(req.admin);
  // Without users.view_pii a person is "Rahim K." and the email is masked.
  const shownName = (name: string) => (pii ? name : friendName(name));
  const stamp = new Date().toISOString().slice(0, 10);

  let filters: Record<string, unknown>;
  let result: { rows: number; truncated: boolean };

  if (type === "referrals") {
    const q = ReferralAdminQueries.list.parse(req.query);
    filters = { status: q.status, flagged: q.flagged, q: q.q, from: q.from, to: q.to, includeTest: q.includeTest };
    const where = referralWhere(q, pii);
    const fetch = (after: Keyed | undefined, take: number) =>
      prisma.referral.findMany({
        where,
        ...keyset(after, take),
        include: {
          referrer: { select: userSelect },
          referee: { select: userSelect },
          rewards: { select: { kind: true, status: true } },
        },
      });
    type Row = Awaited<ReturnType<typeof fetch>>[number];
    const rewardStatus = (r: Row, kind: RewardKind) => r.rewards.find((w) => w.kind === kind)?.status ?? null;
    const columns: CsvColumn<Row>[] = [
      { header: "Referral ID", value: (r) => r.id },
      { header: "Created at", value: (r) => r.createdAt },
      { header: "Code", value: (r) => r.code },
      { header: "Channel", value: (r) => r.channel },
      { header: "Status", value: (r) => r.status },
      { header: "Risk flags", value: (r) => r.riskFlags.join(" ") },
      { header: "Referrer ID", value: (r) => r.referrer.id },
      { header: "Referrer", value: (r) => shownName(r.referrer.name) },
      { header: "Referrer email", value: (r) => r.referrer.email, pii: "email" },
      { header: "Friend ID", value: (r) => r.referee.id },
      { header: "Friend", value: (r) => shownName(r.referee.name) },
      { header: "Friend email", value: (r) => r.referee.email, pii: "email" },
      { header: "Joined at", value: (r) => r.joinedAt },
      { header: "Qualified at", value: (r) => r.qualifiedAt },
      { header: "Qualifying booking ID", value: (r) => r.qualifyingAppointmentId ?? r.qualifyingHomeBookingId },
      { header: "Welcome reward", value: (r) => rewardStatus(r, RewardKind.REFEREE_WELCOME) },
      { header: "Referrer reward", value: (r) => rewardStatus(r, RewardKind.REFERRER_BONUS) },
      { header: "No referrer reward because", value: (r) => r.referrerRewardSkip },
      { header: "Rejected reason", value: (r) => r.rejectedReason },
      { header: "Test", value: (r) => r.isTest },
    ];
    result = await streamCsv(res, {
      filename: `referrals-${stamp}.csv`,
      columns,
      showPii: pii,
      fetchBatch: (after, take) => fetch(after, take),
    });
  } else {
    const q = ReferralAdminQueries.rewards.parse(req.query);
    filters = { kind: q.kind, status: q.status, q: q.q, includeTest: q.includeTest };
    const where = rewardWhere(q, pii);
    const fetch = (after: Keyed | undefined, take: number) =>
      prisma.referralReward.findMany({ where, ...keyset(after, take), include: { user: { select: userSelect } } });
    type Row = Awaited<ReturnType<typeof fetch>>[number];
    const columns: CsvColumn<Row>[] = [
      { header: "Reward ID", value: (r) => r.id },
      { header: "Created at", value: (r) => r.createdAt },
      { header: "Kind", value: (r) => r.kind },
      { header: "Status", value: (r) => r.status },
      { header: "Percent", value: (r) => r.percentBps / 100 },
      { header: "Cap (BDT)", value: (r) => r.maxDiscountMinor, money: true },
      { header: "Minimum order (BDT)", value: (r) => r.minOrderMinor, money: true },
      { header: "Scope", value: (r) => r.scope },
      { header: "First booking only", value: (r) => r.firstBookingOnly },
      { header: "Expires at", value: (r) => r.expiresAt },
      { header: "Discount (BDT)", value: (r) => r.discountMinor, money: true },
      { header: "Customer ID", value: (r) => r.user.id },
      { header: "Customer", value: (r) => shownName(r.user.name) },
      { header: "Customer email", value: (r) => r.user.email, pii: "email" },
      { header: "Referral ID", value: (r) => r.referralId },
      { header: "Booking ID", value: (r) => r.appointmentId },
      { header: "Home visit ID", value: (r) => r.homeBookingId },
      { header: "Redeemed at", value: (r) => r.redeemedAt },
      { header: "Revoked at", value: (r) => r.revokedAt },
      { header: "Revoke reason", value: (r) => r.revokeReason },
      { header: "Expired because", value: (r) => r.expiredReason },
      { header: "Grant reason", value: (r) => r.grantReason },
    ];
    result = await streamCsv(res, {
      filename: `referral-rewards-${stamp}.csv`,
      columns,
      showPii: pii,
      fetchBatch: (after, take) => fetch(after, take),
    });
  }

  await audit(req.auditCtx, {
    action: "export.create",
    entityType: "export",
    entityId: type === "referrals" ? "referrals" : "referral_rewards",
    after: { kind: type, ...filters, pii, rows: result.rows, truncated: result.truncated },
  });
};

export const ReferralAdmin = {
  overview,
  listReferrals,
  getReferral,
  approveReferral,
  rejectReferral,
  listRewards,
  revokeReward,
  grantReward,
  adminResetCode,
  blockUser,
  unblockUser,
  user360Referral,
  reviewQueue,
  exportCsv,
};
