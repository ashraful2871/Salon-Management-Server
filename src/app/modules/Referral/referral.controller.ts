import { NextFunction, Request, Response } from "express";
import { JwtPayload } from "jsonwebtoken";
import { StatusCodes } from "http-status-codes";
import { Prisma, RewardStatus } from "@prisma/client";
import config from "../../../config";
import ApiError from "../../Error/error";
import catchAsync from "../../shared/catchAsync";
import prisma from "../../shared/prisma";
import sendResponse from "../../shared/sendResponse";
import { SITE_NAME } from "../../utils/brand";
import { impersonationOf } from "../../utils/impersonation";
import { ensureCode, findReferrerByCode } from "./referral.codes";
import { fillShareMessage, firstNameOf, friendName, monthStartDhaka, rewardLabel } from "./referral.math";
import { rememberReferrerDevice } from "./referral.risk";
import { loadReferralSettings, type ReferralSettings } from "./referral.settings";

/**
 * Customer + public referral endpoints (mounted at /referrals). Friends are
 * shown as "Rahim K." - never an email or phone. Money fields end in `Minor`,
 * so sendResponse adds the taka twins.
 */

const PAGE_SIZE = 20;

const ROLE_NOUN: Record<string, string> = {
  STAFF: "a stylist",
  SALON_OWNER: "a salon owner",
  BRANCH_MANAGER: "a branch manager",
  ADMIN: "an admin",
  AGENT: "an agent",
};

/**
 * After auth(): every role but CUSTOMER gets 403 `CUSTOMER_ONLY` with a
 * sentence (the booking page's wording; a local copy, since the Referral
 * module imports no other module's code).
 */
export const customerOnly = (req: Request, _res: Response, next: NextFunction) => {
  const role = req.user?.role;
  if (role === "CUSTOMER") return next();
  next(
    ApiError.withCode(
      StatusCodes.FORBIDDEN,
      `Only customer accounts can invite friends and earn rewards. You are signed in as ${
        ROLE_NOUN[role ?? ""] ?? "a non-customer account"
      }; sign in with a customer account to use invites.`,
      "CUSTOMER_ONLY",
    ),
  );
};

const friendTerms = (s: ReferralSettings) => ({
  percent: s.refereePercent,
  maxDiscountMinor: s.refereeMaxDiscountMinor,
  minOrderMinor: s.minOrderMinor,
  validDays: s.refereeValidDays,
  scope: s.refereeScope,
});

const youTerms = (s: ReferralSettings) => ({
  percent: s.referrerPercent,
  maxDiscountMinor: s.referrerMaxDiscountMinor,
  minOrderMinor: s.minOrderMinor,
  validDays: s.referrerValidDays,
  scope: s.referrerScope,
  trigger: s.referrerTrigger,
});

const pageOf = (raw: unknown) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 1;
};

/**
 * GET /referrals/code/:code - the invite landing page. A valid and an invalid
 * code answer the same shape after the same single indexed read, so the reply
 * says only "valid or not". `signedIn`: invite links are for new accounts.
 */
const lookupCode = catchAsync(async (req: Request, res: Response) => {
  const [hit, s] = await Promise.all([findReferrerByCode(String(req.params.code ?? "")), loadReferralSettings()]);
  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Invite code checked",
    data: {
      valid: !!hit,
      firstName: hit ? firstNameOf(hit.user.name) || null : null,
      programOn: s.enabled,
      signedIn: !!req.user,
      terms: friendTerms(s),
    },
  });
});

/** Rewards that count as earned (issued and not withdrawn). */
const EARNED: RewardStatus[] = ["AVAILABLE", "RESERVED", "REDEEMED", "EXPIRED"];

/**
 * GET /referrals/me - the Refer page: code (made on first visit), link, terms,
 * stats and the share text. Remembers this device/network as the referrer's
 * (not while an admin is viewing as the user).
 */
const getMe = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const [codeRow, s] = await Promise.all([ensureCode(userId), loadReferralSettings()]);

  if (!impersonationOf(req.user as JwtPayload)) {
    try {
      await rememberReferrerDevice(userId, req);
    } catch (err) {
      console.error("[referral] rememberReferrerDevice failed", (err as Error).message);
    }
  }

  const [joined, qualified, rewardsEarned, saved, thisMonth] = await Promise.all([
    prisma.referral.count({ where: { referrerId: userId, joinedAt: { not: null }, status: { not: "REJECTED" } } }),
    prisma.referral.count({ where: { referrerId: userId, status: "QUALIFIED" } }),
    prisma.referralReward.count({ where: { userId, kind: "REFERRER_BONUS", status: { in: EARNED } } }),
    prisma.referralReward.aggregate({ where: { userId, status: "REDEEMED" }, _sum: { discountMinor: true } }),
    // What the monthly cap counts: referrer rewards issued since the 1st (Dhaka), held ones included.
    prisma.referralReward.count({
      where: { userId, kind: "REFERRER_BONUS", status: { not: "REVOKED" }, createdAt: { gte: monthStartDhaka(new Date()) } },
    }),
  ]);

  const link = `${config.frontend_url}/r/${codeRow.code}`;
  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Your referral code",
    data: {
      code: codeRow.code,
      link,
      programOn: s.enabled,
      /** A blocked code no longer works for new friends. */
      blocked: !!codeRow.blockedAt,
      terms: {
        friend: friendTerms(s),
        you: youTerms(s),
        /** 0 = no cap. */
        maxPerMonth: s.maxRewardsPerMonth,
        attributionDays: s.attributionDays,
      },
      stats: {
        joined,
        qualified,
        rewardsEarned,
        savedMinor: saved._sum.discountMinor ?? 0,
        thisMonth,
      },
      shareMessage: fillShareMessage(s.shareMessage, {
        percent: s.refereePercent,
        code: codeRow.code,
        link,
        site: SITE_NAME,
        capMinor: s.refereeMaxDiscountMinor,
      }),
    },
  });
});

const ACTIVE_APPOINTMENT = ["PENDING", "CONFIRMED", "CHECKED_IN", "IN_PROGRESS"] as const;
const ACTIVE_HOME = ["CONFIRMED", "EN_ROUTE", "ARRIVED", "IN_PROGRESS"] as const;

type FriendStep = "JOINED" | "BOOKED" | "COMPLETED" | "REWARDED" | "IN_REVIEW" | "NOT_ELIGIBLE";

/** GET /referrals/me/friends?page - who joined with my code and how far each has got. */
const getFriends = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const page = pageOf(req.query.page);
  const where = { referrerId: userId };

  const [rows, total] = await Promise.all([
    prisma.referral.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        status: true,
        createdAt: true,
        joinedAt: true,
        refereeId: true,
        referee: { select: { name: true } },
        rewards: { where: { kind: "REFERRER_BONUS" }, select: { status: true } },
      },
    }),
    prisma.referral.count({ where }),
  ]);

  const ids = rows.map((r) => r.refereeId);
  const customers = (list: { customerId: string }[]) => new Set(list.map((b) => b.customerId));
  const [activeA, activeH, doneA, doneH] =
    ids.length === 0
      ? [[], [], [], []]
      : await Promise.all([
          prisma.appointment.findMany({
            where: { customerId: { in: ids }, status: { in: [...ACTIVE_APPOINTMENT] } },
            select: { customerId: true },
            distinct: ["customerId"],
          }),
          prisma.homeBooking.findMany({
            where: { customerId: { in: ids }, status: { in: [...ACTIVE_HOME] } },
            select: { customerId: true },
            distinct: ["customerId"],
          }),
          prisma.appointment.findMany({
            where: { customerId: { in: ids }, status: "COMPLETED" },
            select: { customerId: true },
            distinct: ["customerId"],
          }),
          prisma.homeBooking.findMany({
            where: { customerId: { in: ids }, status: "COMPLETED" },
            select: { customerId: true },
            distinct: ["customerId"],
          }),
        ]);
  const active = new Set([...customers(activeA), ...customers(activeH)]);
  const completed = new Set([...customers(doneA), ...customers(doneH)]);

  const stepOf = (r: (typeof rows)[number]): FriendStep => {
    if (r.status === "REJECTED" || r.status === "EXPIRED") return "NOT_ELIGIBLE";
    const bonus = r.rewards[0];
    if (bonus?.status === "PENDING_REVIEW") return "IN_REVIEW";
    if (bonus?.status === "REVOKED") return "NOT_ELIGIBLE";
    if (bonus) return "REWARDED";
    if (r.status === "QUALIFIED" || completed.has(r.refereeId)) return "COMPLETED";
    if (active.has(r.refereeId)) return "BOOKED";
    return "JOINED";
  };

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Friends who joined with your code",
    meta: { page, limit: PAGE_SIZE, total },
    data: rows.map((r) => ({
      id: r.id,
      name: friendName(r.referee.name),
      joinedAt: r.joinedAt ?? r.createdAt,
      status: r.status,
      step: stepOf(r),
    })),
  });
});

const rewardInclude = {
  referral: {
    select: {
      qualifyingAppointmentId: true,
      qualifyingHomeBookingId: true,
      referee: { select: { name: true } },
    },
  },
} satisfies Prisma.ReferralRewardInclude;

type RewardWithReferral = Prisma.ReferralRewardGetPayload<{ include: typeof rewardInclude }>;

const sourceOf = (r: RewardWithReferral) => {
  if (r.kind === "REFEREE_WELCOME") return "Welcome reward";
  if (r.kind === "MANUAL_GRANT" || !r.referral) return `From the ${SITE_NAME} team`;
  const friend = friendName(r.referral.referee.name);
  return r.referral.qualifyingAppointmentId || r.referral.qualifyingHomeBookingId
    ? `${friend} completed their first booking`
    : `${friend} joined with your code`;
};

/** GET /referrals/me/rewards?status&page - my rewards, usable ones first. */
const getRewards = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const page = pageOf(req.query.page);
  const status = typeof req.query.status === "string" ? (req.query.status as RewardStatus) : undefined;
  const where: Prisma.ReferralRewardWhereInput = { userId, ...(status && { status }) };

  const [rows, total] = await Promise.all([
    prisma.referralReward.findMany({
      where,
      // Enum order: PENDING_REVIEW, AVAILABLE, RESERVED, REDEEMED, EXPIRED, REVOKED.
      orderBy: [{ status: "asc" }, { expiresAt: "asc" }, { id: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: rewardInclude,
    }),
    prisma.referralReward.count({ where }),
  ]);

  // Booking refs only for a reward held by or spent on a booking.
  const onBooking = rows.filter((r) => r.status === "RESERVED" || r.status === "REDEEMED");
  const apptIds = onBooking.map((r) => r.appointmentId).filter((id): id is string => !!id);
  const homeIds = onBooking.map((r) => r.homeBookingId).filter((id): id is string => !!id);
  const [appts, homes] = await Promise.all([
    apptIds.length
      ? prisma.appointment.findMany({ where: { id: { in: apptIds } }, select: { id: true, token: true } })
      : [],
    homeIds.length
      ? prisma.homeBooking.findMany({ where: { id: { in: homeIds } }, select: { id: true, code: true } })
      : [],
  ]);
  const tokenOf = new Map(appts.map((a) => [a.id, a.token]));
  const codeOf = new Map(homes.map((h) => [h.id, h.code]));

  const bookingOf = (r: RewardWithReferral) => {
    if (r.status !== "RESERVED" && r.status !== "REDEEMED") return null;
    if (r.appointmentId) return { kind: "SALON" as const, id: r.appointmentId, ref: tokenOf.get(r.appointmentId) ?? null };
    if (r.homeBookingId) return { kind: "HOME" as const, id: r.homeBookingId, ref: codeOf.get(r.homeBookingId) ?? null };
    return null;
  };

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Your rewards",
    meta: { page, limit: PAGE_SIZE, total },
    data: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: rewardLabel(r.kind, r.percentBps),
      percent: r.percentBps / 100,
      maxDiscountMinor: r.maxDiscountMinor,
      minOrderMinor: r.minOrderMinor,
      scope: r.scope,
      firstBookingOnly: r.firstBookingOnly,
      expiresAt: r.expiresAt,
      status: r.status,
      discountMinor: r.discountMinor,
      booking: bookingOf(r),
      source: sourceOf(r),
      createdAt: r.createdAt,
    })),
  });
});

/**
 * GET /referrals/me/rewards/summary - for the booking flow's teaser: how many
 * usable rewards, and the best one (highest percent, then the larger cap with
 * 0 = no cap first, then the earliest expiry).
 */
const getRewardsSummary = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const now = new Date();
  const [rows, s] = await Promise.all([
    prisma.referralReward.findMany({
      where: { userId, status: "AVAILABLE", expiresAt: { gt: now } },
      select: { kind: true, percentBps: true, maxDiscountMinor: true, scope: true, expiresAt: true },
    }),
    loadReferralSettings(),
  ]);
  const capRank = (m: number) => (m === 0 ? Number.MAX_SAFE_INTEGER : m);
  const best = [...rows].sort(
    (a, b) =>
      b.percentBps - a.percentBps ||
      capRank(b.maxDiscountMinor) - capRank(a.maxDiscountMinor) ||
      a.expiresAt.getTime() - b.expiresAt.getTime(),
  )[0];

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Rewards summary",
    data: {
      available: rows.length,
      /** Off: quotes apply no reward, so the teaser should stay hidden. */
      redemptionsOn: s.redemptionsEnabled,
      best: best
        ? {
            label: rewardLabel(best.kind, best.percentBps),
            percent: best.percentBps / 100,
            maxDiscountMinor: best.maxDiscountMinor,
            scope: best.scope,
            expiresAt: best.expiresAt,
          }
        : null,
    },
  });
});

export const ReferralController = { lookupCode, getMe, getFriends, getRewards, getRewardsSummary };
