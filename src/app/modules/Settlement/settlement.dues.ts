import { BookingPause, LedgerAccount, Prisma, SalonStatus } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import config from "../../../config";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { audit, AuditCtx, auditTx, systemAuditCtx } from "../../utils/audit";
import { sendEmail } from "../../utils/emailSender";
import { getDuesNoticeTemplate } from "../../utils/emailTemplates";
import { formatBDT } from "../../utils/money";
import { getSetting } from "../../utils/settings";
import { addDays, dhakaDay } from "../Analytics/analytics.days";
import { getOwnerBuckets } from "./settlement.buckets";
import { writeJournal } from "./settlement.service";

/** Fixed SALON_PAYABLE descriptions; owner.money maps both to type "dues". */
export const DUES_PAID_DESCRIPTION = "Dues paid by owner";
export const DUES_WAIVED_DESCRIPTION = "Dues waived by platform";

/** The smallest dues payment a gateway session is started for (৳10). */
export const MIN_DUES_PAYMENT_MINOR = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const RUN_HOUR_DHAKA = 10;
const WARNING_DAYS = 3;
/** `alert_states` row holding the Dhaka day dues.watch last ran for. */
const DAY_KEY = "dues.watch.lastDay";

const duesUrl = () => `${config.frontend_url}/dashboard/money`;

type Branch = { salonId: string | null; balanceMinor: number };
export type DuesAllocation = { salonId: string | null; amountMinor: number };

/** Branches whose unpaid balance (available + pending) is negative, most negative first. */
export const negativeBranches = async (
  ownerId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<Branch[]> => {
  const buckets = await getOwnerBuckets(ownerId, { db });
  return buckets.perSalon
    .map((s) => ({ salonId: s.salonId, balanceMinor: s.pendingMinor + s.availableMinor }))
    .filter((s) => s.balanceMinor < 0)
    .sort(
      (a, b) =>
        a.balanceMinor - b.balanceMinor || String(a.salonId).localeCompare(String(b.salonId)),
    );
};

/**
 * Splits `amountMinor` over `branches` (most negative first), each up to what
 * it owes. Anything left over - dues shrank between paying and settling -
 * lands on the first branch, or on `fallbackSalonId` when none owes, and is
 * paid back in a later payout.
 */
export const allocateDues = (
  branches: Branch[],
  amountMinor: number,
  fallbackSalonId: string | null = null,
): DuesAllocation[] => {
  let left = amountMinor;
  const out: DuesAllocation[] = [];
  for (const branch of branches) {
    if (left <= 0) break;
    const take = Math.min(left, -branch.balanceMinor);
    out.push({ salonId: branch.salonId, amountMinor: take });
    left -= take;
  }
  if (left > 0) {
    if (out.length) out[0].amountMinor += left;
    else out.push({ salonId: fallbackSalonId, amountMinor: left });
  }
  return out;
};

const oldestBranch = async (ownerId: string, db: Prisma.TransactionClient) =>
  (
    await db.salon.findFirst({
      where: { ownerId, isDeleted: false },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    })
  )?.id ?? null;

/**
 * Books a settled SALON_DUES intent: one balanced set per branch, all sharing
 * the intent's id as journalId. Runs inside the intent's claim transaction, so
 * a replayed IPN/return/reconcile never writes it twice. Never touches a wallet.
 */
export const settleDuesPayment = async (
  tx: Prisma.TransactionClient,
  intent: { id: string; referenceId: string | null; amountMinor: number },
  via: string,
) => {
  const ownerId = intent.referenceId;
  if (!ownerId) throw new Error(`SALON_DUES intent ${intent.id} has no owner`);

  const branches = await negativeBranches(ownerId, tx);
  const fallback = branches.length ? null : await oldestBranch(ownerId, tx);
  const parts = allocateDues(branches, intent.amountMinor, fallback);

  for (const part of parts) {
    await writeJournal(tx, {
      journalId: intent.id,
      salonId: part.salonId,
      ownerId,
      kind: "dues",
      drafts: [
        { account: LedgerAccount.SALON_PAYABLE, amountMinor: part.amountMinor, description: DUES_PAID_DESCRIPTION },
        { account: LedgerAccount.PLATFORM_CASH, amountMinor: -part.amountMinor, description: `Dues received via ${via}` },
      ],
    });
  }
  return parts;
};

/**
 * Admin waiver: credits the most negative branch (or the oldest one) from
 * platform revenue. `journalId` lets a four-eyes replay stay one journal.
 */
export const waiveDues = async (
  tx: Prisma.TransactionClient,
  input: { ownerId: string; amountMinor: number; reason: string; journalId?: string },
) => {
  const [first] = await negativeBranches(input.ownerId, tx);
  const salonId = first ? first.salonId : await oldestBranch(input.ownerId, tx);
  const journalId = await writeJournal(tx, {
    journalId: input.journalId,
    salonId,
    ownerId: input.ownerId,
    kind: "dues.waiver",
    drafts: [
      { account: LedgerAccount.SALON_PAYABLE, amountMinor: input.amountMinor, description: DUES_WAIVED_DESCRIPTION },
      { account: LedgerAccount.PLATFORM_REVENUE, amountMinor: -input.amountMinor, description: `Dues waiver: ${input.reason}` },
    ],
  });
  return { journalId, salonId };
};

// ---------------------------------------------------------------------------
// Pause / resume
// ---------------------------------------------------------------------------

/** Every active branch not already paused → DUES. OWNER pauses are left alone. */
export const pauseForDues = (ownerId: string, db: Prisma.TransactionClient = prisma) =>
  db.salon.updateMany({
    where: { ownerId, isDeleted: false, status: SalonStatus.ACTIVE, bookingPause: BookingPause.NONE },
    data: {
      bookingPause: BookingPause.DUES,
      bookingPauseReason: "Unpaid dues",
      bookingPausedAt: new Date(),
      bookingPauseUntil: null,
    },
  });

/** Clears DUES pauses only. */
export const resumeDuesPause = (ownerId: string, db: Prisma.TransactionClient = prisma) =>
  db.salon.updateMany({
    where: { ownerId, bookingPause: BookingPause.DUES },
    data: { bookingPause: BookingPause.NONE, bookingPauseReason: null, bookingPausedAt: null, bookingPauseUntil: null },
  });

const ownerContact = (ownerId: string) =>
  prisma.salonOwner.findUnique({
    where: { id: ownerId },
    select: { id: true, businessName: true, user: { select: { name: true, email: true } } },
  });

const notify = async (
  ownerId: string,
  kind: "reminder" | "warning" | "paused" | "resumed",
  duesMinor: number,
  pauseDate?: string,
) => {
  const owner = await ownerContact(ownerId);
  if (!owner?.user.email) return;
  const subject = {
    reminder: `You owe ${formatBDT(duesMinor)} - pay with bKash`,
    warning: "Online bookings pause in 3 days",
    paused: "Online bookings are paused",
    resumed: "Online bookings resumed",
  }[kind];
  await sendEmail(
    owner.user.email,
    subject,
    getDuesNoticeTemplate({
      ownerName: owner.user.name,
      kind,
      amount: formatBDT(duesMinor),
      pauseDate: pauseDate ?? null,
      url: duesUrl(),
    }),
  );
};

/**
 * After money reached an owner's balance (a dues payment, a waiver): at 0 dues
 * clear the tracking and any DUES pause, and say so when something resumed.
 * Never throws.
 */
export const afterDuesChange = async (ownerId: string, ctx?: AuditCtx) => {
  try {
    const { duesMinor } = await getOwnerBuckets(ownerId);
    if (duesMinor > 0) return { resumed: 0 };
    await prisma.salonOwner.update({
      where: { id: ownerId },
      data: { duesSince: null, duesWarnedAt: null },
    });
    const { count } = await resumeDuesPause(ownerId);
    if (count > 0) {
      await audit(ctx ?? systemAuditCtx("job"), {
        action: "dues.resume",
        entityType: "SalonOwner",
        entityId: ownerId,
        after: { salonsResumed: count },
      });
      await notify(ownerId, "resumed", 0);
    }
    return { resumed: count };
  } catch (err) {
    console.error(`[dues] afterDuesChange failed for owner=${ownerId}`, err);
    return { resumed: 0 };
  }
};

// ---------------------------------------------------------------------------
// Job dues.watch
// ---------------------------------------------------------------------------

/** Dues per owner (unpaid SALON_PAYABLE below zero), in one query. */
export const duesByOwner = async () => {
  const rows = await prisma.ledgerEntry.groupBy({
    by: ["ownerId"],
    where: { account: LedgerAccount.SALON_PAYABLE, payoutId: null, ownerId: { not: null } },
    _sum: { amountMinor: true },
  });
  const out = new Map<string, number>();
  for (const row of rows) {
    const sum = row._sum.amountMinor ?? 0;
    if (row.ownerId && sum < 0) out.set(row.ownerId, -sum);
  }
  return out;
};

/**
 * One owner's step. Pure-ish so verify:money can drive it with a fixed clock.
 * Returns what happened.
 */
export const watchOwner = async (
  owner: { id: string; duesSince: Date | null; duesWarnedAt: Date | null },
  duesMinor: number,
  rules: { pauseEnabled: boolean; creditLimitMinor: number; maxAgeDays: number },
  now: Date,
  opts: { email?: boolean; db?: Prisma.TransactionClient } = {},
) => {
  const db = opts.db ?? prisma;
  const email = opts.email ?? true;
  const ctx = systemAuditCtx("job");

  if (duesMinor <= 0) {
    if (owner.duesSince || owner.duesWarnedAt) {
      await db.salonOwner.update({ where: { id: owner.id }, data: { duesSince: null, duesWarnedAt: null } });
    }
    const { count } = await resumeDuesPause(owner.id, db);
    if (count > 0) {
      await auditTx(db, ctx, { action: "dues.resume", entityType: "SalonOwner", entityId: owner.id, after: { salonsResumed: count } });
      if (email) await notify(owner.id, "resumed", 0);
    }
    return count > 0 ? "resumed" : "clear";
  }

  const since = owner.duesSince ?? now;
  if (!owner.duesSince) {
    await db.salonOwner.update({ where: { id: owner.id }, data: { duesSince: since } });
  }
  const ageDays = Math.floor((now.getTime() - since.getTime()) / DAY_MS);
  const over = duesMinor > rules.creditLimitMinor || ageDays > rules.maxAgeDays;

  if (rules.pauseEnabled && over) {
    if (!owner.duesWarnedAt) {
      await db.salonOwner.update({ where: { id: owner.id }, data: { duesWarnedAt: now } });
      if (email) await notify(owner.id, "warning", duesMinor, addDays(dhakaDay(now), WARNING_DAYS));
      return "warned";
    }
    if (now.getTime() - owner.duesWarnedAt.getTime() >= WARNING_DAYS * DAY_MS - 60 * 60 * 1000) {
      const { count } = await pauseForDues(owner.id, db);
      if (count > 0) {
        await auditTx(db, ctx, {
          action: "dues.pause",
          entityType: "SalonOwner",
          entityId: owner.id,
          after: { salonsPaused: count, duesMinor },
        });
        if (email) await notify(owner.id, "paused", duesMinor);
        return "paused";
      }
      return "still_paused";
    }
    return "warning_pending";
  }

  // Weekly reminder: the day dues began, then every 7 days.
  if (ageDays % 7 === 0) {
    if (email) await notify(owner.id, "reminder", duesMinor);
    return "reminded";
  }
  return "owing";
};

/**
 * Job `dues.watch`, hourly; acts once per Dhaka day on the first run at or
 * after 10:00 Dhaka (marked in `alert_states` before working).
 */
export const runDuesWatch = async (now = new Date()) => {
  const clockHour = new Date(now.getTime() + 6 * 60 * 60 * 1000).getUTCHours();
  if (clockHour < RUN_HOUR_DHAKA) return { ran: false, reason: "before 10:00 Dhaka" };

  const today = dhakaDay(now);
  const state = await prisma.alertState.findUnique({ where: { key: DAY_KEY } });
  if ((state?.detail as { day?: string } | null)?.day === today) {
    return { ran: false, reason: "already ran today", day: today };
  }
  await prisma.alertState.upsert({
    where: { key: DAY_KEY },
    create: { key: DAY_KEY, status: "OK", detail: { day: today } },
    update: { detail: { day: today }, lastNotifiedAt: new Date() },
  });

  const [pauseEnabled, creditLimitMinor, maxAgeDays, dues] = await Promise.all([
    getSetting("dues.pauseEnabled"),
    getSetting("dues.creditLimitMinor"),
    getSetting("dues.maxAgeDays"),
    duesByOwner(),
  ]);
  const rules = { pauseEnabled, creditLimitMinor, maxAgeDays };

  // Owners with dues, plus those still tracked or paused that may have cleared.
  const owners = await prisma.salonOwner.findMany({
    where: {
      OR: [
        { id: { in: [...dues.keys()] } },
        { duesSince: { not: null } },
        { duesWarnedAt: { not: null } },
        { salons: { some: { bookingPause: BookingPause.DUES } } },
      ],
    },
    select: { id: true, duesSince: true, duesWarnedAt: true },
  });

  const tally: Record<string, number> = {};
  for (const owner of owners) {
    try {
      const outcome = await watchOwner(owner, dues.get(owner.id) ?? 0, rules, now);
      tally[outcome] = (tally[outcome] ?? 0) + 1;
    } catch (err) {
      console.error(`[dues.watch] owner=${owner.id} failed`, err);
      tally.error = (tally.error ?? 0) + 1;
    }
  }
  return { ran: true, day: today, owners: owners.length, ...tally };
};

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/**
 * Admin waiver of part or all of a business's dues (never more than it owes).
 * `approvalId` (four-eyes replay) becomes the journalId and makes a second run
 * a no-op.
 */
export const adjustDues = async (
  input: { ownerId: string; amountMinor: number; reason: string; approvalId?: string },
  ctx: AuditCtx | undefined,
) => {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Amount must be a positive whole number of poisha");
  }
  const owner = await prisma.salonOwner.findUnique({ where: { id: input.ownerId }, select: { id: true } });
  if (!owner) throw new ApiError(StatusCodes.NOT_FOUND, "Owner not found");

  const result = await prisma.$transaction(async (tx) => {
    if (input.approvalId) {
      const done = await tx.ledgerEntry.findFirst({ where: { journalId: input.approvalId }, select: { id: true } });
      if (done) return null;
    }
    const { duesMinor } = await getOwnerBuckets(input.ownerId, { db: tx });
    if (input.amountMinor > duesMinor) {
      throw new ApiError(
        StatusCodes.BAD_REQUEST,
        `This business owes ${formatBDT(duesMinor)} - a waiver can't be more than that`,
      );
    }
    const waived = await waiveDues(tx, { ...input, journalId: input.approvalId });
    await auditTx(tx, ctx, {
      action: "dues.adjust",
      entityType: "SalonOwner",
      entityId: input.ownerId,
      salonId: waived.salonId,
      before: { duesMinor },
      after: { duesMinor: duesMinor - input.amountMinor, waivedMinor: input.amountMinor, journalId: waived.journalId },
      reason: input.reason,
    });
    return { ...waived, duesBeforeMinor: duesMinor, duesAfterMinor: duesMinor - input.amountMinor };
  }, { maxWait: 10_000, timeout: 15_000 });

  if (result) await afterDuesChange(input.ownerId, ctx);
  return result ?? { alreadyApplied: true };
};

/** Every business with dues or a DUES pause, largest dues first. */
export const listOwnerDues = async (opts: { includeTest?: boolean } = {}) => {
  const dues = await duesByOwner();
  const owners = await prisma.salonOwner.findMany({
    where: {
      OR: [{ id: { in: [...dues.keys()] } }, { salons: { some: { bookingPause: BookingPause.DUES } } }],
      ...(opts.includeTest ? {} : { user: { isTest: false } }),
    },
    select: {
      id: true,
      businessName: true,
      duesSince: true,
      duesWarnedAt: true,
      user: { select: { name: true, email: true } },
      salons: {
        where: { isDeleted: false, bookingPause: BookingPause.DUES },
        select: { bookingPausedAt: true },
      },
    },
  });
  const now = Date.now();
  return owners
    .map((o) => ({
      ownerId: o.id,
      ownerName: o.user.name,
      email: o.user.email,
      businessName: o.businessName,
      duesMinor: dues.get(o.id) ?? 0,
      since: o.duesSince,
      ageDays: o.duesSince ? Math.floor((now - o.duesSince.getTime()) / DAY_MS) : null,
      warnedAt: o.duesWarnedAt,
      paused: o.salons.length > 0,
      pausedSalons: o.salons.length,
      pausedAt: o.salons[0]?.bookingPausedAt ?? null,
    }))
    .sort((a, b) => b.duesMinor - a.duesMinor);
};
