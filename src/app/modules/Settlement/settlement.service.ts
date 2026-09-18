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
 * Platform defaults, used when no CommissionRule row matches. These encode the
 * pitch: we charge for customers we brought, and nothing for the salon's own.
 *
 *   salon's own repeat customer   0
 *   new customer                  8% of the bill
 *   off-peak fill                 5% of the bill
 *
 * Always a share of the bill, never a flat fee. A flat BDT 10 is a third of a
 * BDT 30 trim and a rounding error on a BDT 5,000 bridal package, so it lands
 * hardest on exactly the cheap bookings the platform wants flowing. Tune with
 * PLATFORM_COMMISSION_PERCENT / OFF_PEAK_COMMISSION_PERCENT - percent, not
 * basis points, and fractions are allowed (7.5 is valid).
 */
const percentToBps = (value: string | undefined, fallbackBps: number) => {
  if (value === undefined || value.trim() === "") return fallbackBps;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return fallbackBps;
  return Math.round(parsed * 100);
};

/** Read on use, not at import: dotenv runs after this module is first loaded. */
const defaultPercentBps = () =>
  percentToBps(process.env.PLATFORM_COMMISSION_PERCENT, 800); // 8%

const offPeakPercentBps = () =>
  percentToBps(process.env.OFF_PEAK_COMMISSION_PERCENT, 500); // 5%

const bps = (amountMinor: number, basisPoints: number) =>
  Math.round((amountMinor * basisPoints) / 10000);

/**
 * Off-peak is the quiet part of the Bangladeshi working week - a slot the salon
 * would most likely not have sold at all. Tune the window with OFF_PEAK_START_HOUR
 * and OFF_PEAK_END_HOUR; Friday and Saturday are always peak.
 */
export const isOffPeak = (startsAt: Date): boolean => {
  const day = startsAt.getDay(); // 0 Sun ... 5 Fri, 6 Sat
  if (day === 5 || day === 6) return false;

  // Read on use, for the same reason as the percentages above.
  const startHour = Number(process.env.OFF_PEAK_START_HOUR ?? 11);
  const endHour = Number(process.env.OFF_PEAK_END_HOUR ?? 16);

  const hour = startsAt.getHours();
  return hour >= startHour && hour < endHour;
};

/**
 * Has this customer completed a booking at this salon before? A salon's repeat
 * customer is never commissioned, so this decides whether we earn anything.
 */
export const isNewCustomerForSalon = async (
  customerId: string,
  salonId: string,
  excludeAppointmentId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<boolean> => {
  const previous = await db.appointment.findFirst({
    where: {
      customerId,
      salonId,
      status: "COMPLETED",
      id: { not: excludeAppointmentId },
    },
    select: { id: true },
  });

  return previous === null;
};

const feeFromRule = (
  rule: { flatFeeMinor: number | null; percentBps: number | null },
  amountMinor: number,
): number => {
  const flat = rule.flatFeeMinor ?? null;
  const percent =
    rule.percentBps === null ? null : bps(amountMinor, rule.percentBps);

  // Both set means "whichever is lower" - that is how the off-peak rule reads.
  if (flat !== null && percent !== null) return Math.min(flat, percent);
  if (flat !== null) return flat;
  if (percent !== null) return percent;
  return 0;
};

export const resolveCommissionMinor = async (args: {
  salonId: string;
  amountMinor: number;
  isNewCustomer: boolean;
  offPeak: boolean;
  source: "PLATFORM" | "SALON_DIRECT";
  db?: Prisma.TransactionClient;
}): Promise<number> => {
  const db = args.db ?? prisma;

  // The rule that sells the platform: their own customer, their own money.
  if (args.source === "SALON_DIRECT" || !args.isNewCustomer) return 0;
  if (args.amountMinor <= 0) return 0;

  const scopes: CommissionScope[] = [CommissionScope.ALL];
  if (args.isNewCustomer) scopes.push(CommissionScope.NEW_CUSTOMER);
  if (args.offPeak) scopes.push(CommissionScope.OFF_PEAK);

  const rules = await db.commissionRule.findMany({
    where: {
      isActive: true,
      OR: [{ salonId: args.salonId }, { salonId: null }],
      appliesTo: { in: scopes },
      minAmountMinor: { lte: args.amountMinor },
      AND: [
        {
          OR: [
            { maxAmountMinor: null },
            { maxAmountMinor: { gte: args.amountMinor } },
          ],
        },
      ],
    },
    orderBy: [{ priority: "desc" }, { minAmountMinor: "desc" }],
  });

  // A salon-specific rule always beats the platform default.
  const winner =
    rules.find((rule) => rule.salonId === args.salonId) ?? rules[0];

  if (winner) {
    return Math.max(0, Math.min(feeFromRule(winner, args.amountMinor), args.amountMinor));
  }

  // No configured rule - fall back to the documented platform defaults. Both
  // bands are a straight percentage of the bill, so the fee scales with the
  // booking instead of landing hardest on the cheapest one.
  const fallback = bps(
    args.amountMinor,
    args.offPeak ? offPeakPercentBps() : defaultPercentBps(),
  );

  return Math.max(0, Math.min(fallback, args.amountMinor));
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
export const SettlementService = {
  resolveCommissionMinor,
  isNewCustomerForSalon,
  isOffPeak,
  recordCompletedBooking,
  recordForfeitedDeposit,
  reverseForfeitedDeposit,
  getSalonBalance,
  runPayoutBatch,
  getAllPayouts,
  updatePayoutStatus,
  getMyPayouts,
  findUnbalancedAppointments,
  recordGoodwillCredit,
};

// ---------------------------------------------------------------------------
// Commission rule administration
// ---------------------------------------------------------------------------

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
