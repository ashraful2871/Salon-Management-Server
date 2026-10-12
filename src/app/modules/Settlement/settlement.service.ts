import {
  Appointment,
  CommissionScope,
  LedgerAccount,
  PayoutAccount,
  PayoutAccountStatus,
  PayoutStatus,
  Prisma,
} from "@prisma/client";
import { randomUUID } from "crypto";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { AuditOpts, auditTx, diff, systemAuditCtx } from "../../utils/audit";
import { getSetting, getSettingSync } from "../../utils/settings";
import { getSalonEarnings } from "./settlement.earnings";
import { holdCutoff, payoutScope, salonBalances } from "./settlement.buckets";
import { AccessUser, scopeSalonIds } from "../../utils/salonAccess";
import { sendEmail } from "../../utils/emailSender";
import { getPayoutUpdateTemplate } from "../../utils/emailTemplates";
import { formatBDT } from "../../utils/money";

/**
 * Who is owed what, and why.
 *
 * Every appointment writes a set of ledger entries that sums to zero across
 * accounts. That identity is the reconciliation test: if a salon's entries do
 * not net out against the platform's, money was invented somewhere.
 */

// ---------------------------------------------------------------------------
// Commission
// ---------------------------------------------------------------------------

/**
 * One rate, every booking: the platform takes 10% of the bill.
 *
 * There is no peak / off-peak split, no new-versus-repeat customer distinction
 * and no exemption for a salon-direct booking - every completed appointment is
 * commissioned identically, so a salon can read its own cut straight off the
 * bill and the dashboard only ever has one number to state.
 *
 * Always a share of the bill, never a flat fee. A flat BDT 10 is a third of a
 * BDT 30 trim and a rounding error on a BDT 5,000 bridal package, so it lands
 * hardest on exactly the cheap bookings the platform wants flowing. Tune with
 * the booking.commissionPercent setting (admin console; env
 * PLATFORM_COMMISSION_PERCENT before any edit) - percent, not basis points,
 * and fractions are allowed (7.5 is valid).
 */
const percentToBps = (percent: number) => Math.round(percent * 100);

/**
 * The rate in force now, in basis points. The platform setting
 * booking.commissionPercent (env PLATFORM_COMMISSION_PERCENT, else 10%).
 * A booking snapshots it as commissionBps when it is made.
 */
export const currentCommissionBps = async () =>
  percentToBps(await getSetting("booking.commissionPercent"));

const commissionPercentBps = () =>
  percentToBps(getSettingSync("booking.commissionPercent"));

const bps = (amountMinor: number, basisPoints: number) =>
  Math.round((amountMinor * basisPoints) / 10000);

/**
 * What the platform charges on a completed booking. CommissionRule rows are
 * deliberately not consulted: the rate is flat for every salon and every
 * customer, so there is nothing left to look up per booking.
 */
export const resolveCommissionMinor = (
  amountMinor: number,
  basisPoints?: number,
): number => {
  if (amountMinor <= 0) return 0;

  const fee = bps(amountMinor, basisPoints ?? commissionPercentBps());
  return Math.max(0, Math.min(fee, amountMinor));
};

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

type EntryDraft = {
  account: LedgerAccount;
  amountMinor: number;
  description: string;
};

type JournalInput = {
  appointmentId?: string | null;
  salonId: string | null;
  /** The business; read from the salon when not given. */
  ownerId?: string | null;
  /** What the set is, for the refusal message (e.g. "booking.completed"). */
  kind: string;
  drafts: EntryDraft[];
};

/**
 * The only writer of ledger_entries. One call is one journal: a set of rows
 * that sums to zero and shares a journalId - the appointment's id for a
 * booking's sets, else a fresh uuid. Returns the journalId, or null when every
 * draft was zero and nothing was written.
 */
export const writeJournal = async (
  db: Prisma.TransactionClient,
  input: JournalInput,
) => {
  const entries = input.drafts.filter((entry) => entry.amountMinor !== 0);
  if (entries.length === 0) return null;

  const sum = entries.reduce((total, entry) => total + entry.amountMinor, 0);

  if (sum !== 0) {
    // Refusing to write is the right call: an unbalanced set is unfixable once
    // it is in, and it would poison every reconciliation run afterwards.
    throw new ApiError(
      StatusCodes.INTERNAL_SERVER_ERROR,
      `Refusing to write an unbalanced ledger set (${input.kind}${input.appointmentId ? `, appointment ${input.appointmentId}` : ""}) - sums to ${sum}`,
    );
  }

  const journalId = input.appointmentId ?? randomUUID();
  let ownerId = input.ownerId ?? null;
  if (!ownerId && input.salonId) {
    const salon = await db.salon.findUnique({
      where: { id: input.salonId },
      select: { ownerId: true },
    });
    ownerId = salon?.ownerId ?? null;
  }

  await db.ledgerEntry.createMany({
    data: entries.map((entry) => ({
      journalId,
      appointmentId: input.appointmentId ?? null,
      salonId: input.salonId,
      ownerId,
      account: entry.account,
      amountMinor: entry.amountMinor,
      description: entry.description,
    })),
  });

  return journalId;
};

/** A booking's set: journal = the appointment, business = its salon's owner. */
const bookingJournal = (
  db: Prisma.TransactionClient,
  appointment: { id: string; salonId: string },
  kind: string,
  drafts: EntryDraft[],
) =>
  writeJournal(db, {
    appointmentId: appointment.id,
    salonId: appointment.salonId,
    kind,
    drafts,
  });

/** Nothing should ever write a second set of entries for the same appointment. */
const hasEntries = async (db: Prisma.TransactionClient, appointmentId: string) =>
  (await db.ledgerEntry.count({ where: { appointmentId } })) > 0;

/**
 * A completed booking: the deposit the customer already paid becomes money we
 * owe the salon, and our commission comes back out of it.
 */
export const recordCompletedBooking = async (
  db: Prisma.TransactionClient,
  appointment: Appointment,
  commissionMinor: number,
) => {
  if (await hasEntries(db, appointment.id)) return;

  const deposit = appointment.depositMinor;

  await bookingJournal(db, appointment, "booking.completed", [
    {
      account: LedgerAccount.CUSTOMER_WALLET,
      amountMinor: -deposit,
      description: "Deposit applied to the bill",
    },
    {
      account: LedgerAccount.SALON_PAYABLE,
      amountMinor: deposit,
      description: "Deposit owed to salon",
    },
    {
      account: LedgerAccount.SALON_PAYABLE,
      amountMinor: -commissionMinor,
      description: "Platform commission deducted",
    },
    {
      account: LedgerAccount.PLATFORM_REVENUE,
      amountMinor: commissionMinor,
      description: "Platform commission",
    },
  ]);
};

/** A forfeited deposit, split per the salon's configured share. */
export const recordForfeitedDeposit = async (
  db: Prisma.TransactionClient,
  appointment: Appointment,
  salonSharePct: number,
) => {
  if (await hasEntries(db, appointment.id)) return;

  const deposit = appointment.depositMinor;
  if (deposit <= 0) return;

  const clampedPct = Math.min(Math.max(salonSharePct, 0), 100);
  const salonShare = Math.round((deposit * clampedPct) / 100);
  const platformShare = deposit - salonShare;

  await bookingJournal(db, appointment, "booking.forfeit", [
    {
      account: LedgerAccount.CUSTOMER_WALLET,
      amountMinor: -deposit,
      description: "Deposit forfeited",
    },
    {
      account: LedgerAccount.SALON_PAYABLE,
      amountMinor: salonShare,
      description: "Salon share of forfeited deposit",
    },
    {
      account: LedgerAccount.PLATFORM_REVENUE,
      amountMinor: platformShare,
      description: "Platform share of forfeited deposit",
    },
  ]);
};

/**
 * A late cancellation. Unlike a forfeit the platform takes nothing: the whole
 * penalty goes to the salon, because the salon is the one left with an empty
 * chair it can no longer sell. A zero penalty writes nothing, which keeps the
 * `hasEntries` guard free for a later correction.
 */
export const recordLateCancellationPenalty = async (
  db: Prisma.TransactionClient,
  appointment: Appointment,
  penaltyMinor: number,
) => {
  if (penaltyMinor <= 0) return;
  if (await hasEntries(db, appointment.id)) return;

  await bookingJournal(db, appointment, "booking.late_cancel", [
    {
      account: LedgerAccount.CUSTOMER_WALLET,
      amountMinor: -penaltyMinor,
      description: "Late cancellation fee",
    },
    {
      account: LedgerAccount.SALON_PAYABLE,
      amountMinor: penaltyMinor,
      description: "Late cancellation fee kept by salon",
    },
  ]);
};

/**
 * Reverses a forfeit after a successful appeal. The original rows stay - a
 * correction is a new compensating set, never an edit.
 */
export const reverseForfeitedDeposit = async (
  db: Prisma.TransactionClient,
  appointment: Appointment,
  salonSharePct: number,
) => {
  const deposit = appointment.depositMinor;
  if (deposit <= 0) return;

  const clampedPct = Math.min(Math.max(salonSharePct, 0), 100);
  const salonShare = Math.round((deposit * clampedPct) / 100);
  const platformShare = deposit - salonShare;

  await bookingJournal(db, appointment, "booking.forfeit_reversed", [
    {
      account: LedgerAccount.CUSTOMER_WALLET,
      amountMinor: deposit,
      description: "Forfeit reversed on appeal",
    },
    {
      account: LedgerAccount.SALON_PAYABLE,
      amountMinor: -salonShare,
      description: "Salon share reversed on appeal",
    },
    {
      account: LedgerAccount.PLATFORM_REVENUE,
      amountMinor: -platformShare,
      description: "Platform share reversed on appeal",
    },
  ]);
};

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

/**
 * What a salon is owed and not yet in a payout: unpaid SALON_PAYABLE, netted,
 * both available (past the hold) and pending (still inside it).
 */
const getSalonBalance = async (salonId: string) => {
  const cutoff = holdCutoff(await getSetting("payouts.holdDays"));
  const [available, pending] = await Promise.all(
    [{ lte: cutoff }, { gt: cutoff }].map((createdAt) =>
      prisma.ledgerEntry.aggregate({
        where: { salonId, account: LedgerAccount.SALON_PAYABLE, payoutId: null, createdAt },
        _sum: { amountMinor: true },
      }),
    ),
  );
  const availableMinor = available._sum.amountMinor ?? 0;
  const pendingMinor = pending._sum.amountMinor ?? 0;

  return {
    salonId,
    payableMinor: availableMinor + pendingMinor,
    availableMinor,
    pendingMinor,
  };
};

type BusinessGroup = {
  ownerId: string;
  businessName: string;
  isTest: boolean;
  salonIds: string[];
  salonNames: string[];
  area: string | null;
  netMinor: number;
  oldestAt: Date;
};

type SkipReason =
  | "below minimum"
  | "dues"
  | "frozen"
  | "no verified account"
  | "account cooldown";

type Destination = { account: PayoutAccount | null; frozen: boolean };

/**
 * Where each business would be paid: its VERIFIED payout account (at most one;
 * verifying a new one disables the old) and whether Finance froze its payouts.
 */
const payoutDestinations = async (
  ownerIds: string[],
  db: Prisma.TransactionClient = prisma,
): Promise<Map<string, Destination>> => {
  if (ownerIds.length === 0) return new Map();
  const [owners, accounts] = await Promise.all([
    db.salonOwner.findMany({
      where: { id: { in: ownerIds } },
      select: { id: true, payoutsFrozen: true },
    }),
    db.payoutAccount.findMany({
      where: { ownerId: { in: ownerIds }, status: PayoutAccountStatus.VERIFIED },
      orderBy: { verifiedAt: "desc" },
    }),
  ]);
  const map = new Map<string, Destination>();
  for (const owner of owners) {
    map.set(owner.id, {
      frozen: owner.payoutsFrozen,
      account: accounts.find((a) => a.ownerId === owner.id) ?? null,
    });
  }
  return map;
};

/** Frozen, no verified account, or the account is still in its cooldown. */
const destinationSkip = (dest: Destination | undefined, now = new Date()): SkipReason | null =>
  dest?.frozen
    ? "frozen"
    : !dest?.account
      ? "no verified account"
      : dest.account.cooldownUntil && dest.account.cooldownUntil > now
        ? "account cooldown"
        : null;

/** What the payout records about where it is going (no full number). */
const destinationSnapshot = (account: PayoutAccount) => ({
  type: account.type,
  accountName: account.accountName,
  last4: account.last4,
  bankName: account.bankName,
  routingNumber: account.routingNumber,
});

/**
 * Every business's available SALON_PAYABLE up to `cutoff`, netted across its
 * salons. One groupBy for the money, one read each for the names.
 */
const payableBusinesses = async (
  cutoff: Date,
  db: Prisma.TransactionClient = prisma,
  ownerId?: string,
): Promise<BusinessGroup[]> => {
  const grouped = await db.ledgerEntry.groupBy({
    by: ["ownerId", "salonId"],
    where: {
      account: LedgerAccount.SALON_PAYABLE,
      payoutId: null,
      ownerId: ownerId ?? { not: null },
      createdAt: { lte: cutoff },
    },
    _sum: { amountMinor: true },
    _min: { createdAt: true },
  });
  if (grouped.length === 0) return [];

  const ownerIds = [...new Set(grouped.map((row) => row.ownerId as string))];
  const salonIds = [
    ...new Set(grouped.map((row) => row.salonId).filter((id): id is string => !!id)),
  ];
  const [owners, salons] = await Promise.all([
    db.salonOwner.findMany({
      where: { id: { in: ownerIds } },
      select: { id: true, businessName: true, user: { select: { name: true, isTest: true } } },
    }),
    db.salon.findMany({
      where: { id: { in: salonIds } },
      select: { id: true, name: true, area: true, isTest: true },
    }),
  ]);
  const ownerById = new Map(owners.map((owner) => [owner.id, owner]));
  const salonById = new Map(salons.map((salon) => [salon.id, salon]));

  const byOwner = new Map<string, BusinessGroup>();
  for (const row of grouped) {
    const ownerId = row.ownerId as string;
    const owner = ownerById.get(ownerId);
    const salon = row.salonId ? salonById.get(row.salonId) : undefined;
    const group =
      byOwner.get(ownerId) ??
      ({
        ownerId,
        businessName: owner?.businessName || owner?.user.name || "Unknown business",
        isTest: owner?.user.isTest ?? false,
        salonIds: [],
        salonNames: [],
        area: null,
        netMinor: 0,
        oldestAt: row._min.createdAt ?? cutoff,
      } satisfies BusinessGroup);

    group.netMinor += row._sum.amountMinor ?? 0;
    if (row._min.createdAt && row._min.createdAt < group.oldestAt) {
      group.oldestAt = row._min.createdAt;
    }
    if (row.salonId) {
      group.salonIds.push(row.salonId);
      group.salonNames.push(salon?.name ?? "Deleted branch");
      group.area ??= salon?.area ?? null;
      if (salon?.isTest) group.isTest = true;
    }
    byOwner.set(ownerId, group);
  }

  return [...byOwner.values()].sort((a, b) => b.netMinor - a.netMinor);
};

/** The payout rules in force: the hold, the minimum, and the cutoff they give. */
const batchRules = async (periodEnd?: Date) => {
  const [holdDays, minMinor] = await Promise.all([
    getSetting("payouts.holdDays"),
    getSetting("payouts.minMinor"),
  ]);
  const held = holdCutoff(holdDays);
  const cutoff = periodEnd && periodEnd < held ? periodEnd : held;
  return { holdDays, minMinor, cutoff };
};

const skipReason = (netMinor: number, minMinor: number): SkipReason | null =>
  netMinor <= 0 ? "dues" : netMinor < minMinor ? "below minimum" : null;

const businessRow = (group: BusinessGroup) => ({
  ownerId: group.ownerId,
  businessName: group.businessName,
  // The single salon when the business has one; a business payout otherwise.
  salonId: group.salonIds.length === 1 ? group.salonIds[0] : null,
  salonName:
    group.salonNames.length === 1
      ? group.salonNames[0]
      : `${group.salonNames.length} branches`,
  salons: group.salonIds.length,
  area: group.area,
  isTest: group.isTest,
  netMinor: group.netMinor,
});

/**
 * What `runPayoutBatch` would raise right now, without writing anything: the
 * same grouping, hold and minimum, so the totals match.
 */
const previewPayoutBatch = async (input?: {
  periodEnd?: Date;
  /** One business only. */
  ownerId?: string;
  db?: Prisma.TransactionClient;
}) => {
  const { cutoff, holdDays, minMinor } = await batchRules(input?.periodEnd);
  const groups = await payableBusinesses(cutoff, input?.db, input?.ownerId);
  const destinations = await payoutDestinations(
    groups.map((group) => group.ownerId),
    input?.db,
  );

  const rows: Array<ReturnType<typeof businessRow>> = [];
  const skipped: Array<ReturnType<typeof businessRow> & { reason: SkipReason }> = [];
  for (const group of groups) {
    const reason =
      skipReason(group.netMinor, minMinor) ?? destinationSkip(destinations.get(group.ownerId));
    if (reason) skipped.push({ ...businessRow(group), reason });
    else rows.push(businessRow(group));
  }

  return {
    periodEnd: cutoff,
    holdDays,
    minMinor,
    rows,
    skipped,
    totals: {
      salons: rows.length,
      netMinor: rows.reduce((total, row) => total + row.netMinor, 0),
    },
  };
};

/**
 * Rolls each business's available SALON_PAYABLE rows (past the hold, across
 * all its salons) into one Payout. Entries are claimed with a `payoutId: null`
 * filter, so two concurrent runs cannot put the same entry into two payouts.
 */
const runPayoutBatch = async (
  input?: {
    /** Accepted for older callers; a payout's start is its oldest entry. */
    periodStart?: Date;
    periodEnd?: Date;
    /** One business only. */
    ownerId?: string;
    /** Run inside this transaction instead of one per business. */
    db?: Prisma.TransactionClient;
  },
  opts: AuditOpts = {},
) => {
  const auditCtx = opts.ctx ?? systemAuditCtx("job");
  const { cutoff: periodEnd, minMinor } = await batchRules(input?.periodEnd);
  const groups = await payableBusinesses(periodEnd, input?.db, input?.ownerId);
  const destinations = await payoutDestinations(
    groups.map((group) => group.ownerId),
    input?.db,
  );
  const inTx = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    input?.db ? fn(input.db) : prisma.$transaction(fn);

  const created: Array<{
    payoutId: string;
    ownerId: string;
    businessName: string;
    salonId: string | null;
    netMinor: number;
  }> = [];
  const skipped: Array<{
    ownerId: string;
    businessName: string;
    salonId: string | null;
    netMinor: number;
    reason: SkipReason;
  }> = [];

  for (const group of groups) {
    const row = businessRow(group);
    const reason = skipReason(group.netMinor, minMinor);

    // Nothing owed, the business owes us, or too little to send: carry it
    // into the next run rather than raising a payout.
    if (reason) {
      skipped.push({ ...pick(row), reason });
      continue;
    }

    // Only to a verified account past its cooldown, and never while frozen.
    const destReason = destinationSkip(destinations.get(group.ownerId));
    if (destReason) {
      skipped.push({ ...pick(row), reason: destReason });
      continue;
    }
    const account = destinations.get(group.ownerId)!.account!;

    const payout = await inTx(async (tx) => {
      // Re-read under the transaction: Finance may have replaced it since.
      const stillVerified = await tx.payoutAccount.count({
        where: { id: account.id, status: PayoutAccountStatus.VERIFIED },
      });
      if (stillVerified === 0) return null;

      const entries = await tx.ledgerEntry.findMany({
        where: {
          ownerId: group.ownerId,
          account: LedgerAccount.SALON_PAYABLE,
          payoutId: null,
          createdAt: { lte: periodEnd },
        },
        select: { id: true, amountMinor: true, salonId: true, createdAt: true },
      });

      if (entries.length === 0) return null;

      const grossMinor = entries
        .filter((entry) => entry.amountMinor > 0)
        .reduce((total, entry) => total + entry.amountMinor, 0);
      const commissionMinor = entries
        .filter((entry) => entry.amountMinor < 0)
        .reduce((total, entry) => total - entry.amountMinor, 0);
      const settledNet = grossMinor - commissionMinor;

      // Re-checked on the rows actually claimed: they may have moved since the
      // grouping read.
      if (skipReason(settledNet, minMinor)) return null;

      const salonIds = [
        ...new Set(entries.map((entry) => entry.salonId).filter((id): id is string => !!id)),
      ];
      const periodStart = entries.reduce(
        (oldest, entry) => (entry.createdAt < oldest ? entry.createdAt : oldest),
        periodEnd,
      );

      const payoutRow = await tx.payout.create({
        data: {
          ownerId: group.ownerId,
          salonId: salonIds.length === 1 ? salonIds[0] : null,
          periodStart,
          periodEnd,
          grossMinor,
          commissionMinor,
          netMinor: settledNet,
          status: PayoutStatus.PENDING,
          payoutAccountId: account.id,
          destinationSnapshot: destinationSnapshot(account),
        },
      });

      const claimed = await tx.ledgerEntry.updateMany({
        where: { id: { in: entries.map((entry) => entry.id) }, payoutId: null },
        data: { payoutId: payoutRow.id },
      });

      // Somebody else claimed these entries between the read and the write.
      if (claimed.count !== entries.length) {
        throw new ApiError(
          StatusCodes.CONFLICT,
          "Ledger entries changed while building the payout - retry the batch",
        );
      }

      await auditTx(tx, auditCtx, {
        action: "payout.run",
        entityType: "payout",
        entityId: payoutRow.id,
        salonId: payoutRow.salonId,
        after: {
          ownerId: group.ownerId,
          salons: salonIds.length,
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
          grossMinor,
          commissionMinor,
          netMinor: settledNet,
          entries: entries.length,
        },
        reason: opts.reason,
      });

      return payoutRow;
    });

    if (payout) {
      created.push({ ...pick(row), payoutId: payout.id, salonId: payout.salonId, netMinor: payout.netMinor });
    }
  }

  return { periodStart: input?.periodStart ?? null, periodEnd, created, skipped };
};

const pick = (row: ReturnType<typeof businessRow>) => ({
  ownerId: row.ownerId,
  businessName: row.businessName,
  salonId: row.salonId,
  netMinor: row.netMinor,
});

/** A payout's salon (null for a multi-branch business payout) and business. */
const PAYOUT_OWNER_INCLUDE = {
  salon: { select: { id: true, name: true } },
  owner: { select: { id: true, businessName: true } },
} satisfies Prisma.PayoutInclude;

const getAllPayouts = async (query: any) => {
  const { page = 1, limit = 20, status, salonId } = query;
  const pageNum = Number(page);
  const limitNum = Number(limit);

  const where: Prisma.PayoutWhereInput = {};
  if (status) where.status = status as PayoutStatus;
  if (salonId) where.salonId = salonId;

  const [data, total] = await Promise.all([
    prisma.payout.findMany({
      where,
      skip: (pageNum - 1) * limitNum,
      take: limitNum,
      orderBy: { createdAt: "desc" },
      include: {
        salon: { select: { id: true, name: true, phone: true, area: true } },
        owner: { select: { id: true, businessName: true } },
      },
    }),
    prisma.payout.count({ where }),
  ]);

  return { meta: { page: pageNum, limit: limitNum, total }, data };
};

/**
 * Where a payout may go from each status. PENDING -> PAID skips the APPROVED
 * step, so with four-eyes on it only happens through an approved request.
 * PAID, FAILED and CANCELLED are terminal: FAILED and CANCELLED hand their
 * entries back to the balance, so moving them again would pay twice.
 */
export const PAYOUT_TRANSITIONS = {
  PENDING: ["APPROVED", "PROCESSING", "PAID", "CANCELLED"],
  APPROVED: ["PROCESSING", "PAID", "CANCELLED"],
  PROCESSING: ["PAID", "FAILED"],
  PAID: [],
  FAILED: [],
  CANCELLED: [],
} as const satisfies Record<PayoutStatus, readonly PayoutStatus[]>;

export const canTransitionPayout = (from: PayoutStatus, to: PayoutStatus) =>
  (PAYOUT_TRANSITIONS[from] as readonly PayoutStatus[]).includes(to);

type PayoutStatusChange = {
  status: PayoutStatus;
  method?: string;
  reference?: string;
  proofUrl?: string;
  failureReason?: string;
  cancelledReason?: string;
  /** Who marked it paid: the requester, also when a second admin approved it. */
  markedPaidById?: string | null;
};

export type PayoutTransitionPayload = Omit<PayoutStatusChange, "status">;

export type PayoutTransitionOpts = AuditOpts & {
  /** Set by the four-eyes executor: a second admin already approved this. */
  fourEyesCleared?: boolean;
};

const PAYOUT_TERMINAL_MESSAGE: Partial<Record<PayoutStatus, string>> = {
  PAID: "This payout is already marked as paid",
  FAILED:
    "This payout failed. Its money is back in the salon's balance and will go in the next payout.",
  CANCELLED:
    "This payout was cancelled. Its money is back in the salon's balance and will go in the next payout.",
};

const illegalMove = (from: PayoutStatus, to: PayoutStatus) =>
  new ApiError(
    StatusCodes.CONFLICT,
    PAYOUT_TERMINAL_MESSAGE[from] ?? `A payout cannot go from ${from} to ${to}`,
  );

/**
 * Detaches a payout's ledger entries so they count as payable again. Run it in
 * the transaction that marks the payout FAILED or CANCELLED. Returns how many
 * were released.
 */
export const releasePayoutEntries = async (
  db: Prisma.TransactionClient,
  payoutId: string,
) => {
  const released = await db.ledgerEntry.updateMany({
    where: { payoutId },
    data: { payoutId: null },
  });
  return released.count;
};

/**
 * Whether marking this payout paid needs a second admin: approvals are on and
 * either no threshold is set (every payout) or the payout is over it.
 */
export const payoutNeedsApproval = async (netMinor: number) => {
  if (!(await getSetting("approvals.enabled"))) return false;
  const over = await getSetting("approvals.payoutOverMinor");
  return over === null || netMinor > over;
};

/**
 * The checks a move must pass: the payout exists, the move is legal, and the
 * fields that move needs are present. Run again inside `transitionPayout`, and
 * on its own before a "mark paid" is sent for approval.
 */
const assertPayable = async (
  id: string,
  payload: PayoutStatusChange,
  db: Prisma.TransactionClient = prisma,
) => {
  const payout = await db.payout.findUnique({ where: { id } });

  if (!payout) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Payout not found");
  }

  const to = payload.status;
  if (!canTransitionPayout(payout.status, to)) throw illegalMove(payout.status, to);

  if (to === PayoutStatus.PAID && !payload.reference?.trim()) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "A transfer reference is required when marking a payout paid",
    );
  }

  if (to === PayoutStatus.PAID && !payload.method) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "Choose how the payout was sent (bKash or bank) when marking it paid",
    );
  }

  if (to === PayoutStatus.FAILED && !payload.failureReason?.trim()) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Say why the payout failed");
  }

  if (to === PayoutStatus.CANCELLED && !payload.cancelledReason?.trim()) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Say why the payout is cancelled");
  }

  return payout;
};

/**
 * Moves a payout along PAYOUT_TRANSITIONS. The claim is conditional on the
 * status it was read in, so two admins (or an approval and a direct call)
 * cannot both move the same payout. APPROVED stamps the approver; FAILED and
 * CANCELLED release the entries back to the balance in the same transaction.
 */
export const transitionPayout = async (
  id: string,
  to: PayoutStatus,
  payload: PayoutTransitionPayload = {},
  opts: PayoutTransitionOpts = {},
  tx?: Prisma.TransactionClient,
) => {
  const change: PayoutStatusChange = { ...payload, status: to };
  const actorId = opts.ctx?.actorUserId ?? null;

  const run = async (db: Prisma.TransactionClient) => {
    const payout = await assertPayable(id, change, db);
    const from = payout.status;

    // Four-eyes: PAID needs either an approved request or an APPROVED payout
    // whose approver is someone other than the person marking it paid.
    if (
      to === PayoutStatus.PAID &&
      !opts.fourEyesCleared &&
      (await payoutNeedsApproval(payout.netMinor)) &&
      !(from === PayoutStatus.APPROVED && payout.approvedById && payout.approvedById !== actorId)
    ) {
      throw new ApiError(
        StatusCodes.CONFLICT,
        "A second admin must approve this payout before it is marked paid",
      );
    }

    const paid = to === PayoutStatus.PAID;
    const data: Prisma.PayoutUpdateManyMutationInput = { status: to };
    if (to === PayoutStatus.APPROVED) {
      data.approvedById = actorId;
      data.approvedAt = new Date();
    }
    if (paid) {
      data.method = change.method;
      data.reference = change.reference?.trim();
      data.proofUrl = change.proofUrl ?? null;
      data.paidAt = new Date();
      data.markedPaidById = change.markedPaidById ?? actorId;
    }
    if (to === PayoutStatus.PROCESSING && change.method) data.method = change.method;
    if (to === PayoutStatus.FAILED) data.failureReason = change.failureReason?.trim();
    if (to === PayoutStatus.CANCELLED) data.cancelledReason = change.cancelledReason?.trim();

    let claimed;
    try {
      claimed = await db.payout.updateMany({ where: { id, status: from }, data });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") {
        throw new ApiError(
          StatusCodes.CONFLICT,
          "This transfer reference is already recorded on another payout",
        );
      }
      throw error;
    }

    if (claimed.count === 0) {
      const current = await db.payout.findUnique({ where: { id }, select: { status: true } });
      throw illegalMove(current?.status ?? from, to);
    }

    // A failed or cancelled payout hands its money back to the business's
    // balance, so the next run picks it up again.
    const releasedEntries =
      to === PayoutStatus.FAILED || to === PayoutStatus.CANCELLED
        ? await releasePayoutEntries(db, id)
        : undefined;

    const updated = await db.payout.findUniqueOrThrow({ where: { id } });

    const fields = (row: typeof payout) => ({
      status: row.status,
      method: row.method,
      reference: row.reference,
      proofUrl: row.proofUrl,
      failureReason: row.failureReason,
      cancelledReason: row.cancelledReason,
      approvedById: row.approvedById,
    });
    const changes = diff(fields(payout), fields(updated));

    await auditTx(db, opts.ctx ?? systemAuditCtx("job"), {
      action: "payout.update",
      entityType: "payout",
      entityId: id,
      salonId: payout.salonId,
      before: changes.before,
      after:
        releasedEntries === undefined ? changes.after : { ...changes.after, releasedEntries },
      reason: opts.reason,
    });

    return updated;
  };

  const updated = tx ? await run(tx) : await prisma.$transaction(run);

  if (updated.status === PayoutStatus.PAID || updated.status === PayoutStatus.FAILED) {
    void emailPayoutOwner(updated);
  }

  return updated;
};

/** The admin route's and the four-eyes action's entry point. */
const updatePayoutStatus = (
  id: string,
  payload: PayoutStatusChange,
  opts: PayoutTransitionOpts = {},
  tx?: Prisma.TransactionClient,
) => {
  const { status, ...rest } = payload;
  return transitionPayout(id, status, rest, opts, tx);
};

/** PAID and FAILED both reach the business owner. Never throws. */
const emailPayoutOwner = async (payout: {
  ownerId: string;
  salonId: string | null;
  status: PayoutStatus;
  netMinor: number;
  method: string | null;
  reference: string | null;
  failureReason: string | null;
}) => {
  try {
    const owner = await prisma.salonOwner.findUnique({
      where: { id: payout.ownerId },
      select: {
        businessName: true,
        user: { select: { name: true, email: true } },
        salons: payout.salonId
          ? { where: { id: payout.salonId }, select: { name: true } }
          : { select: { name: true }, take: 0 },
      },
    });
    const user = owner?.user;
    if (!owner || !user?.email) return;
    const name = owner.salons[0]?.name ?? owner.businessName ?? "your business";

    const result = await sendEmail(
      user.email,
      payout.status === PayoutStatus.PAID
        ? `Payout sent: ${formatBDT(payout.netMinor)}`
        : "Your payout did not go through",
      getPayoutUpdateTemplate(user.name, name, {
        paid: payout.status === PayoutStatus.PAID,
        amount: formatBDT(payout.netMinor),
        method: payout.method,
        reference: payout.reference,
        failureReason: payout.failureReason,
      }),
    );
    console.log(
      `[payout] ${payout.status} email to the owner of ${name}: ${result.ok ? "sent" : `not sent (${result.error})`}`,
    );
  } catch (error) {
    console.error("[payout] owner email failed", error);
  }
};

/** A salon owner's own settlement view. */
const getMyPayouts = async (user: AccessUser, query: any) => {
  const salonIds =
    (await scopeSalonIds(user, "money.view", query?.salonId)) ?? [];

  if (salonIds.length === 0) {
    return { meta: { page: 1, limit: 0, total: 0 }, data: [], balances: [] };
  }

  const { page = 1, limit = 20 } = query;
  const pageNum = Number(page);
  const limitNum = Number(limit);

  const where = await payoutScope(salonIds);
  const [data, total, balances] = await Promise.all([
    prisma.payout.findMany({
      where,
      skip: (pageNum - 1) * limitNum,
      take: limitNum,
      orderBy: { createdAt: "desc" },
      include: PAYOUT_OWNER_INCLUDE,
    }),
    prisma.payout.count({ where }),
    salonBalances(salonIds),
  ]);

  return { meta: { page: pageNum, limit: limitNum, total }, data, balances };
};

/**
 * Proves the books balance: every journal's entries must sum to zero. The
 * name is historical - a journal is an appointment's id for booking sets, so
 * appointmentId is returned alongside (null for non-booking journals).
 * Anything listed here is a bug that shipped.
 */
const findUnbalancedAppointments = async () =>
  prisma.$queryRaw<Array<{ journalId: string; appointmentId: string | null; total: number }>>`
    SELECT "journalId", MAX("appointmentId") AS "appointmentId", SUM("amountMinor")::int AS total
    FROM ledger_entries
    GROUP BY "journalId"
    HAVING SUM("amountMinor") <> 0
  `;

/**
 * Compensation when the salon cancels on the customer. The salon funds it, so
 * it comes out of what we owe them - that is what keeps it from being a
 * platform subsidy for someone else's cancellation.
 */
export const recordGoodwillCredit = async (
  db: Prisma.TransactionClient,
  appointment: Appointment,
  amountMinor: number,
) => {
  if (amountMinor <= 0) return;
  if (await hasEntries(db, appointment.id)) return;

  await bookingJournal(db, appointment, "booking.goodwill", [
    {
      account: LedgerAccount.CUSTOMER_WALLET,
      amountMinor,
      description: "Goodwill credit - salon cancelled",
    },
    {
      account: LedgerAccount.SALON_PAYABLE,
      amountMinor: -amountMinor,
      description: "Goodwill credit funded by salon",
    },
  ]);
};
/**
 * The whole money picture for one salon owner: the derived totals, the payouts
 * that have been raised, what each salon is owed right now, and the bookings
 * the most recent commission was charged on.
 *
 * It is one call because the earnings screen needs all four together and the
 * frontend caches on a single tag - splitting it would let the cards and the
 * table disagree after a payout run.
 */
const getMyEarnings = async (user: AccessUser, query: any = {}) => {
  const salonIds =
    (await scopeSalonIds(user, "money.view", query?.salonId)) ?? [];
  const salons = salonIds.length
    ? await prisma.salon.findMany({
        where: { id: { in: salonIds } },
        select: { id: true, name: true },
        orderBy: { createdAt: "asc" },
      })
    : [];

  const limit = Math.min(Number(query?.limit ?? 20) || 20, 100);

  if (salonIds.length === 0) {
    return {
      summary: await getSalonEarnings([]),
      payouts: [],
      balances: [],
      salons: [],
      recentBookings: [],
    };
  }

  const [summary, payouts, balances, recentBookings] = await Promise.all([
    getSalonEarnings(salonIds),
    payoutScope(salonIds).then((where) =>
      prisma.payout.findMany({
        where,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: PAYOUT_OWNER_INCLUDE,
      }),
    ),
    salonBalances(salonIds),
    // The line items behind the totals, so an owner can see which booking a
    // commission came from rather than being asked to trust a single number.
    prisma.appointment.findMany({
      where: { salonId: { in: salonIds }, status: "COMPLETED" },
      take: limit,
      orderBy: { appointmentDate: "desc" },
      select: {
        id: true,
        appointmentDate: true,
        startTime: true,
        totalMinor: true,
        depositMinor: true,
        depositStatus: true,
        source: true,
        customer: { select: { name: true } },
        service: { select: { name: true } },
        salon: { select: { id: true, name: true } },
        ledgerEntries: {
          where: { account: LedgerAccount.PLATFORM_REVENUE },
          select: { amountMinor: true },
        },
      },
    }),
  ]);

  const balanceBySalon = new Map(
    balances.map((balance) => [balance.salonId, balance.payableMinor]),
  );

  return {
    summary,
    payouts,
    balances,
    salons: salons.map((salon) => ({
      ...salon,
      payableMinor: balanceBySalon.get(salon.id) ?? 0,
    })),
    recentBookings: recentBookings.map(({ ledgerEntries, ...booking }) => {
      const commissionMinor = ledgerEntries.reduce(
        (total, entry) => total + entry.amountMinor,
        0,
      );

      return {
        ...booking,
        commissionMinor,
        netMinor: booking.totalMinor - commissionMinor,
      };
    }),
  };
};

export const SettlementService = {
  resolveCommissionMinor,
  currentCommissionBps,
  recordCompletedBooking,
  recordForfeitedDeposit,
  recordLateCancellationPenalty,
  reverseForfeitedDeposit,
  getSalonBalance,
  runPayoutBatch,
  previewPayoutBatch,
  getAllPayouts,
  updatePayoutStatus,
  transitionPayout,
  assertPayable,
  getMyPayouts,
  getMyEarnings,
  findUnbalancedAppointments,
  recordGoodwillCredit,
};

// ---------------------------------------------------------------------------
// Commission rule administration
// ---------------------------------------------------------------------------
//
// NOTE: these rows no longer affect what a booking is charged. The rate is a
// flat PLATFORM_COMMISSION_PERCENT for every salon and every customer, and
// resolveCommissionMinor does not read this table. The CRUD stays so existing
// rows and admin screens keep working, but editing a rule changes nothing.

const getCommissionRules = async (query: any) => {
  const where: Prisma.CommissionRuleWhereInput = {};

  if (query?.salonId) where.salonId = query.salonId;
  // "platform" asks for the defaults, which are the rows with no salon.
  if (query?.scope === "platform") where.salonId = null;
  if (query?.isActive !== undefined) where.isActive = query.isActive === "true";

  return prisma.commissionRule.findMany({
    where,
    orderBy: [{ salonId: "asc" }, { priority: "desc" }],
    include: { salon: { select: { id: true, name: true } } },
  });
};

const createCommissionRule = async (payload: {
  salonId?: string | null;
  minAmountMinor?: number;
  maxAmountMinor?: number | null;
  flatFeeMinor?: number | null;
  percentBps?: number | null;
  appliesTo: CommissionScope;
  priority?: number;
}) => {
  if (payload.flatFeeMinor == null && payload.percentBps == null) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "A rule needs a flat fee, a percentage, or both",
    );
  }

  if (
    payload.maxAmountMinor != null &&
    payload.maxAmountMinor < (payload.minAmountMinor ?? 0)
  ) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "The maximum amount cannot be below the minimum",
    );
  }

  if (payload.salonId) {
    const salon = await prisma.salon.findFirst({
      where: { id: payload.salonId, isDeleted: false },
      select: { id: true },
    });
    if (!salon) throw new ApiError(StatusCodes.NOT_FOUND, "Salon not found");
  }

  return prisma.commissionRule.create({
    data: {
      salonId: payload.salonId ?? null,
      minAmountMinor: payload.minAmountMinor ?? 0,
      maxAmountMinor: payload.maxAmountMinor ?? null,
      flatFeeMinor: payload.flatFeeMinor ?? null,
      percentBps: payload.percentBps ?? null,
      appliesTo: payload.appliesTo,
      priority: payload.priority ?? 0,
    },
  });
};

const updateCommissionRule = async (id: string, payload: any) => {
  const rule = await prisma.commissionRule.findUnique({ where: { id } });

  if (!rule) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Commission rule not found");
  }

  return prisma.commissionRule.update({ where: { id }, data: payload });
};

export const CommissionAdmin = {
  getCommissionRules,
  createCommissionRule,
  updateCommissionRule,
};
