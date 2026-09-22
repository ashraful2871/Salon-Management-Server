import {
  Appointment,
  CommissionScope,
  LedgerAccount,
  PayoutStatus,
  Prisma,
} from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { getSalonEarnings } from "./settlement.earnings";

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
 * PLATFORM_COMMISSION_PERCENT - percent, not basis points, and fractions are
 * allowed (7.5 is valid).
 */
const percentToBps = (value: string | undefined, fallbackBps: number) => {
  if (value === undefined || value.trim() === "") return fallbackBps;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return fallbackBps;
  return Math.round(parsed * 100);
};

/** Read on use, not at import: dotenv runs after this module is first loaded. */
const commissionPercentBps = () =>
  percentToBps(process.env.PLATFORM_COMMISSION_PERCENT, 1000); // 10%

const bps = (amountMinor: number, basisPoints: number) =>
  Math.round((amountMinor * basisPoints) / 10000);

/**
 * What the platform charges on a completed booking. CommissionRule rows are
 * deliberately not consulted: the rate is flat for every salon and every
 * customer, so there is nothing left to look up per booking.
 */
export const resolveCommissionMinor = (amountMinor: number): number => {
  if (amountMinor <= 0) return 0;

  const fee = bps(amountMinor, commissionPercentBps());
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

const writeEntries = async (
  db: Prisma.TransactionClient,
  appointment: { id: string; salonId: string },
  drafts: EntryDraft[],
) => {
  const entries = drafts.filter((entry) => entry.amountMinor !== 0);
  if (entries.length === 0) return;

  const sum = entries.reduce((total, entry) => total + entry.amountMinor, 0);

  if (sum !== 0) {
    // Refusing to write is the right call: an unbalanced set is unfixable once
    // it is in, and it would poison every reconciliation run afterwards.
    throw new ApiError(
      StatusCodes.INTERNAL_SERVER_ERROR,
      `Refusing to write an unbalanced ledger set for appointment ${appointment.id} (sums to ${sum})`,
    );
  }

  await db.ledgerEntry.createMany({
    data: entries.map((entry) => ({
      appointmentId: appointment.id,
      salonId: appointment.salonId,
      account: entry.account,
      amountMinor: entry.amountMinor,
      description: entry.description,
    })),
  });
};

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

  await writeEntries(db, appointment, [
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

  await writeEntries(db, appointment, [
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

  await writeEntries(db, appointment, [
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

  await writeEntries(db, appointment, [
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

/** What a salon is owed right now: unpaid SALON_PAYABLE, netted. */
const getSalonBalance = async (salonId: string) => {
  const result = await prisma.ledgerEntry.aggregate({
    where: {
      salonId,
      account: LedgerAccount.SALON_PAYABLE,
      payoutId: null,
    },
    _sum: { amountMinor: true },
  });

  return { salonId, payableMinor: result._sum.amountMinor ?? 0 };
};

/**
 * Rolls every salon's unpaid SALON_PAYABLE rows into one Payout each. Entries
 * are claimed with a `payoutId: null` filter, so two concurrent runs cannot
 * put the same entry into two payouts.
 */
const runPayoutBatch = async (input?: {
  periodStart?: Date;
  periodEnd?: Date;
}) => {
  const periodEnd = input?.periodEnd ?? new Date();
  const periodStart =
    input?.periodStart ?? new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

  const grouped = await prisma.ledgerEntry.groupBy({
    by: ["salonId"],
    where: {
      account: LedgerAccount.SALON_PAYABLE,
      payoutId: null,
      salonId: { not: null },
      createdAt: { lte: periodEnd },
    },
    _sum: { amountMinor: true },
  });

  const created: Array<{ payoutId: string; salonId: string; netMinor: number }> =
    [];
  const skipped: Array<{ salonId: string; netMinor: number }> = [];

  for (const group of grouped) {
    const salonId = group.salonId as string;
    const netMinor = group._sum.amountMinor ?? 0;

    // Nothing owed, or the salon owes us: carry it into the next period rather
    // than raising a payout for zero or a negative amount.
    if (netMinor <= 0) {
      skipped.push({ salonId, netMinor });
      continue;
    }

    const payout = await prisma.$transaction(async (tx) => {
      const entries = await tx.ledgerEntry.findMany({
        where: {
          salonId,
          account: LedgerAccount.SALON_PAYABLE,
          payoutId: null,
          createdAt: { lte: periodEnd },
        },
        select: { id: true, amountMinor: true },
      });

      if (entries.length === 0) return null;

      const grossMinor = entries
        .filter((entry) => entry.amountMinor > 0)
        .reduce((total, entry) => total + entry.amountMinor, 0);
      const commissionMinor = entries
        .filter((entry) => entry.amountMinor < 0)
        .reduce((total, entry) => total - entry.amountMinor, 0);
      const settledNet = grossMinor - commissionMinor;

      if (settledNet <= 0) return null;

      const row = await tx.payout.create({
        data: {
          salonId,
          periodStart,
          periodEnd,
          grossMinor,
          commissionMinor,
          netMinor: settledNet,
          status: PayoutStatus.PENDING,
        },
      });

      const claimed = await tx.ledgerEntry.updateMany({
        where: { id: { in: entries.map((entry) => entry.id) }, payoutId: null },
        data: { payoutId: row.id },
      });

      // Somebody else claimed these entries between the read and the write.
      if (claimed.count !== entries.length) {
        throw new ApiError(
          StatusCodes.CONFLICT,
          "Ledger entries changed while building the payout - retry the batch",
        );
      }

      return row;
    });

    if (payout) {
      created.push({
        payoutId: payout.id,
        salonId,
        netMinor: payout.netMinor,
      });
    }
  }

  return { periodStart, periodEnd, created, skipped };
};

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
      },
    }),
    prisma.payout.count({ where }),
  ]);

  return { meta: { page: pageNum, limit: limitNum, total }, data };
};

const updatePayoutStatus = async (
  id: string,
  payload: {
    status: PayoutStatus;
    method?: string;
    reference?: string;
    failureReason?: string;
  },
) => {
  const payout = await prisma.payout.findUnique({ where: { id } });

  if (!payout) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Payout not found");
  }

  if (payout.status === PayoutStatus.PAID) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      "This payout is already marked as paid",
    );
  }

  if (payload.status === PayoutStatus.PAID && !payload.reference?.trim()) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "A transfer reference is required when marking a payout paid",
    );
  }

  return prisma.payout.update({
    where: { id },
    data: {
      status: payload.status,
      method: payload.method,
      reference: payload.reference,
      failureReason: payload.failureReason,
      paidAt: payload.status === PayoutStatus.PAID ? new Date() : null,
    },
  });
};

/** A salon owner's own settlement view. */
const getMyPayouts = async (userId: string, query: any) => {
  const owner = await prisma.salonOwner.findUnique({
    where: { userId },
    include: { salons: { select: { id: true } } },
  });

  if (!owner) {
    throw new ApiError(StatusCodes.FORBIDDEN, "Only salon owners have payouts");
  }

  const salonIds = owner.salons.map((salon) => salon.id);

  if (salonIds.length === 0) {
    return { meta: { page: 1, limit: 0, total: 0 }, data: [], balances: [] };
  }

  const { page = 1, limit = 20 } = query;
  const pageNum = Number(page);
  const limitNum = Number(limit);

  const [data, total, balances] = await Promise.all([
    prisma.payout.findMany({
      where: { salonId: { in: salonIds } },
      skip: (pageNum - 1) * limitNum,
      take: limitNum,
      orderBy: { createdAt: "desc" },
      include: { salon: { select: { id: true, name: true } } },
    }),
    prisma.payout.count({ where: { salonId: { in: salonIds } } }),
    Promise.all(salonIds.map((salonId) => getSalonBalance(salonId))),
  ]);

  return { meta: { page: pageNum, limit: limitNum, total }, data, balances };
};

/**
 * Proves the books balance: every appointment's entries must sum to zero.
 * Anything listed here is a bug that shipped.
 */
const findUnbalancedAppointments = async () =>
  prisma.$queryRaw<Array<{ appointmentId: string; total: number }>>`
    SELECT "appointmentId", SUM("amountMinor")::int AS total
    FROM ledger_entries
    WHERE "appointmentId" IS NOT NULL
    GROUP BY "appointmentId"
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

  await writeEntries(db, appointment, [
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
const getMyEarnings = async (userId: string, query: any = {}) => {
  const owner = await prisma.salonOwner.findUnique({
    where: { userId },
    include: { salons: { select: { id: true, name: true } } },
  });

  if (!owner) {
    throw new ApiError(StatusCodes.FORBIDDEN, "Only salon owners have earnings");
  }

  const salons = owner.salons;
  const salonIds = salons.map((salon) => salon.id);

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
    prisma.payout.findMany({
      where: { salonId: { in: salonIds } },
      take: limit,
      orderBy: { createdAt: "desc" },
      include: { salon: { select: { id: true, name: true } } },
    }),
    Promise.all(salonIds.map((salonId) => getSalonBalance(salonId))),
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
  recordCompletedBooking,
  recordForfeitedDeposit,
  recordLateCancellationPenalty,
  reverseForfeitedDeposit,
  getSalonBalance,
  runPayoutBatch,
  getAllPayouts,
  updatePayoutStatus,
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
