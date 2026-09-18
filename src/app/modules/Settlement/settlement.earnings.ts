import {
  LedgerAccount,
  PayoutStatus,
  Prisma,
  WalletTxType,
} from "@prisma/client";
import prisma from "../../shared/prisma";

/**
 * The read side of the ledger: what a salon has earned, and what the platform
 * has earned from it.
 *
 * Every figure here is derived - from `appointments` for what was billed, from
 * `ledger_entries` for how that split between the salon and us, and from
 * `payouts` for what has actually left the building. Nothing is stored twice
 * and nothing is hardcoded, so a dashboard built on this cannot drift away from
 * the books the way a cached total would.
 *
 * All amounts are poisha under `Minor` names, so `sendResponse` adds the taka
 * twins on the way out.
 */

/** How many months of history the trend series carries. */
const TREND_MONTHS = 6;

const sum = (value: number | null | undefined) => value ?? 0;

/** `2026-09`, the bucket key the monthly queries group on. */
const monthKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

const monthLabel = (key: string) => {
  const [year, month] = key.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleString("en-US", {
    month: "short",
    year: "numeric",
  });
};

/**
 * The first day of the month `TREND_MONTHS - 1` back, and the continuous list
 * of buckets from there to now. Postgres only returns months that had activity;
 * a chart with holes in its axis reads as lost revenue rather than a quiet
 * month, so the gaps are filled here with explicit zeroes.
 */
const trendWindow = () => {
  const now = new Date();
  const start = new Date(
    now.getFullYear(),
    now.getMonth() - (TREND_MONTHS - 1),
    1,
  );

  const keys: string[] = [];
  for (let index = 0; index < TREND_MONTHS; index += 1) {
    keys.push(
      monthKey(new Date(start.getFullYear(), start.getMonth() + index, 1)),
    );
  }

  return { start, keys };
};

export type MonthlyEarnings = {
  month: string;
  label: string;
  grossMinor: number;
  commissionMinor: number;
  netMinor: number;
  bookings: number;
};

const buildMonthly = (
  keys: string[],
  gross: Array<{ month: string; grossMinor: number; bookings: number }>,
  commission: Array<{ month: string; commissionMinor: number }>,
): MonthlyEarnings[] => {
  const grossByMonth = new Map(gross.map((row) => [row.month, row]));
  const commissionByMonth = new Map(
    commission.map((row) => [row.month, row.commissionMinor]),
  );

  return keys.map((month) => {
    const grossMinor = grossByMonth.get(month)?.grossMinor ?? 0;
    const commissionMinor = commissionByMonth.get(month) ?? 0;

    return {
      month,
      label: monthLabel(month),
      grossMinor,
      commissionMinor,
      netMinor: grossMinor - commissionMinor,
      bookings: grossByMonth.get(month)?.bookings ?? 0,
    };
  });
};

/**
 * The one commission rate in force, as a percentage. Read from the same env var
 * the charging path reads, so a dashboard can state the rate without a second
 * copy of the number drifting out of step with what is billed.
 */
export const getCommissionRates = () => {
  const read = (value: string | undefined, fallback: number) => {
    if (value === undefined || value.trim() === "") return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return fallback;
    return parsed;
  };

  return {
    standardCommissionPercent: read(process.env.PLATFORM_COMMISSION_PERCENT, 10),
  };
};

const emptySalonEarnings = () => ({
  grossBookingsMinor: 0,
  commissionMinor: 0,
  netEarningsMinor: 0,
  depositsCollectedMinor: 0,
  counterCollectedMinor: 0,
  depositsHeldMinor: 0,
  payableMinor: 0,
  processingPayoutMinor: 0,
  paidOutMinor: 0,
  failedPayoutMinor: 0,
  todayGrossMinor: 0,
  monthGrossMinor: 0,
  monthCommissionMinor: 0,
  monthNetMinor: 0,
  completedBookings: 0,
  averageTicketMinor: 0,
  effectiveCommissionPercent: 0,
  monthly: [] as MonthlyEarnings[],
  ...getCommissionRates(),
});

export type SalonEarnings = ReturnType<typeof emptySalonEarnings>;

/**
 * Everything a salon owner needs to see about money, across every salon they
 * own. Pass the owner's salon ids; an owner with no salons gets a zeroed shape
 * rather than an error, so the dashboard renders before the first salon is
 * approved.
 */
export const getSalonEarnings = async (
  salonIds: string[],
): Promise<SalonEarnings> => {
  if (salonIds.length === 0) return emptySalonEarnings();

  const ids = Prisma.join(salonIds);
  const { start, keys } = trendWindow();

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [
    completed,
    depositsApplied,
    depositsHeld,
    commission,
    payable,
    payoutsByStatus,
    todayGross,
    monthGross,
    monthCommission,
    monthlyGross,
    monthlyCommission,
  ] = await Promise.all([
    // What customers were billed on bookings that actually happened.
    prisma.appointment.aggregate({
      where: { salonId: { in: salonIds }, status: "COMPLETED" },
      _sum: { totalMinor: true },
      _count: true,
    }),
    // The slice of that which reached the salon through us as a deposit.
    prisma.appointment.aggregate({
      where: {
        salonId: { in: salonIds },
        status: "COMPLETED",
        depositStatus: "APPLIED",
      },
      _sum: { depositMinor: true },
    }),
    // Money already committed against bookings that have not happened yet.
    prisma.appointment.aggregate({
      where: { salonId: { in: salonIds }, depositStatus: "HELD" },
      _sum: { depositMinor: true },
    }),
    // What we charged. PLATFORM_REVENUE rows carry the salon they came from.
    prisma.ledgerEntry.aggregate({
      where: {
        salonId: { in: salonIds },
        account: LedgerAccount.PLATFORM_REVENUE,
      },
      _sum: { amountMinor: true },
    }),
    // Owed but not yet rolled into a payout - this is the next payout.
    prisma.ledgerEntry.aggregate({
      where: {
        salonId: { in: salonIds },
        account: LedgerAccount.SALON_PAYABLE,
        payoutId: null,
      },
      _sum: { amountMinor: true },
    }),
    prisma.payout.groupBy({
      by: ["status"],
      where: { salonId: { in: salonIds } },
      _sum: { netMinor: true },
      _count: true,
    }),
    prisma.appointment.aggregate({
      where: {
        salonId: { in: salonIds },
        status: "COMPLETED",
        appointmentDate: { gte: todayStart },
      },
      _sum: { totalMinor: true },
    }),
    prisma.appointment.aggregate({
      where: {
        salonId: { in: salonIds },
        status: "COMPLETED",
        appointmentDate: { gte: monthStart },
      },
      _sum: { totalMinor: true },
    }),
    prisma.ledgerEntry.aggregate({
      where: {
        salonId: { in: salonIds },
        account: LedgerAccount.PLATFORM_REVENUE,
        createdAt: { gte: monthStart },
      },
      _sum: { amountMinor: true },
    }),
    prisma.$queryRaw<
      Array<{ month: string; grossMinor: number; bookings: number }>
    >`
      SELECT to_char(date_trunc('month', a."appointmentDate"), 'YYYY-MM') AS month,
             COALESCE(SUM(a."totalMinor"), 0)::int AS "grossMinor",
             COUNT(*)::int AS bookings
      FROM appointments a
      WHERE a."salonId" IN (${ids})
        AND a.status = 'COMPLETED'
        AND a."appointmentDate" >= ${start}
      GROUP BY 1
    `,
    // Bucketed by the appointment's date, not the ledger row's, so a month's
    // commission lines up with the bookings it was charged on.
    prisma.$queryRaw<Array<{ month: string; commissionMinor: number }>>`
      SELECT to_char(date_trunc('month', a."appointmentDate"), 'YYYY-MM') AS month,
             COALESCE(SUM(l."amountMinor"), 0)::int AS "commissionMinor"
      FROM ledger_entries l
      JOIN appointments a ON a.id = l."appointmentId"
      WHERE l.account = 'PLATFORM_REVENUE'
        AND a."salonId" IN (${ids})
        AND a."appointmentDate" >= ${start}
      GROUP BY 1
    `,
  ]);

  const grossBookingsMinor = sum(completed._sum.totalMinor);
  const commissionMinor = sum(commission._sum.amountMinor);
  const depositsCollectedMinor = sum(depositsApplied._sum.depositMinor);
  const completedBookings = completed._count;

  const byStatus = (status: PayoutStatus) =>
    sum(payoutsByStatus.find((row) => row.status === status)?._sum.netMinor);

  const monthGrossMinor = sum(monthGross._sum.totalMinor);
  const monthCommissionMinor = sum(monthCommission._sum.amountMinor);

  return {
    grossBookingsMinor,
    commissionMinor,
    netEarningsMinor: grossBookingsMinor - commissionMinor,
    depositsCollectedMinor,
    // The rest of the bill is settled face to face at the salon.
    counterCollectedMinor: Math.max(
      0,
      grossBookingsMinor - depositsCollectedMinor,
    ),
    depositsHeldMinor: sum(depositsHeld._sum.depositMinor),
    payableMinor: sum(payable._sum.amountMinor),
    processingPayoutMinor:
      byStatus(PayoutStatus.PENDING) + byStatus(PayoutStatus.PROCESSING),
    paidOutMinor: byStatus(PayoutStatus.PAID),
    failedPayoutMinor: byStatus(PayoutStatus.FAILED),
    todayGrossMinor: sum(todayGross._sum.totalMinor),
    monthGrossMinor,
    monthCommissionMinor,
    monthNetMinor: monthGrossMinor - monthCommissionMinor,
    completedBookings,
    averageTicketMinor:
      completedBookings > 0
        ? Math.round(grossBookingsMinor / completedBookings)
        : 0,
    // What was actually charged over everything billed. Tracks the headline
    // rate now that every completed booking is commissioned at the same rate;
    // it can still drift on rounding, or on bookings billed before the change.
    effectiveCommissionPercent:
      grossBookingsMinor > 0
        ? Number(((commissionMinor / grossBookingsMinor) * 100).toFixed(2))
        : 0,
    monthly: buildMonthly(keys, monthlyGross, monthlyCommission),
    ...getCommissionRates(),
  };
};

/**
 * The same view from the platform's side of the ledger: what we earned, what we
 * still owe salons, and how much customer money we are holding.
 */
export const getPlatformEarnings = async () => {
  const { start, keys } = trendWindow();

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [
    completed,
    platformRevenue,
    monthRevenue,
    todayRevenue,
    payable,
    payoutsByStatus,
    wallets,
    topups,
    depositsHeld,
    forfeited,
    monthlyGross,
    monthlyCommission,
  ] = await Promise.all([
    prisma.appointment.aggregate({
      where: { status: "COMPLETED" },
      _sum: { totalMinor: true },
      _count: true,
    }),
    prisma.ledgerEntry.aggregate({
      where: { account: LedgerAccount.PLATFORM_REVENUE },
      _sum: { amountMinor: true },
    }),
    prisma.ledgerEntry.aggregate({
      where: {
        account: LedgerAccount.PLATFORM_REVENUE,
        createdAt: { gte: monthStart },
      },
      _sum: { amountMinor: true },
    }),
    prisma.ledgerEntry.aggregate({
      where: {
        account: LedgerAccount.PLATFORM_REVENUE,
        createdAt: { gte: todayStart },
      },
      _sum: { amountMinor: true },
    }),
    prisma.ledgerEntry.aggregate({
      where: { account: LedgerAccount.SALON_PAYABLE, payoutId: null },
      _sum: { amountMinor: true },
    }),
    prisma.payout.groupBy({
      by: ["status"],
      _sum: { netMinor: true },
      _count: true,
    }),
    // Customer money sitting with us. It is a liability, not revenue.
    prisma.wallet.aggregate({ _sum: { balance: true, heldBalance: true } }),
    prisma.walletTransaction.aggregate({
      where: { type: WalletTxType.TOPUP },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.appointment.aggregate({
      where: { depositStatus: "HELD" },
      _sum: { depositMinor: true },
    }),
    prisma.appointment.aggregate({
      where: { depositStatus: "FORFEITED" },
      _sum: { depositMinor: true },
      _count: true,
    }),
    prisma.$queryRaw<
      Array<{ month: string; grossMinor: number; bookings: number }>
    >`
      SELECT to_char(date_trunc('month', a."appointmentDate"), 'YYYY-MM') AS month,
             COALESCE(SUM(a."totalMinor"), 0)::int AS "grossMinor",
             COUNT(*)::int AS bookings
      FROM appointments a
      WHERE a.status = 'COMPLETED'
        AND a."appointmentDate" >= ${start}
      GROUP BY 1
    `,
    prisma.$queryRaw<Array<{ month: string; commissionMinor: number }>>`
      SELECT to_char(date_trunc('month', a."appointmentDate"), 'YYYY-MM') AS month,
             COALESCE(SUM(l."amountMinor"), 0)::int AS "commissionMinor"
      FROM ledger_entries l
      JOIN appointments a ON a.id = l."appointmentId"
      WHERE l.account = 'PLATFORM_REVENUE'
        AND a."appointmentDate" >= ${start}
      GROUP BY 1
    `,
  ]);

  const grossBookingsMinor = sum(completed._sum.totalMinor);
  const platformRevenueMinor = sum(platformRevenue._sum.amountMinor);
  const completedBookings = completed._count;

  const byStatus = (status: PayoutStatus) => {
    const row = payoutsByStatus.find((entry) => entry.status === status);
    return { amountMinor: sum(row?._sum.netMinor), count: row?._count ?? 0 };
  };

  const pending = byStatus(PayoutStatus.PENDING);
  const processing = byStatus(PayoutStatus.PROCESSING);
  const paid = byStatus(PayoutStatus.PAID);
  const failed = byStatus(PayoutStatus.FAILED);

  return {
    grossBookingsMinor,
    platformRevenueMinor,
    monthRevenueMinor: sum(monthRevenue._sum.amountMinor),
    todayRevenueMinor: sum(todayRevenue._sum.amountMinor),
    salonPayableMinor: sum(payable._sum.amountMinor),
    salonEarningsMinor: grossBookingsMinor - platformRevenueMinor,
    pendingPayoutMinor: pending.amountMinor + processing.amountMinor,
    pendingPayoutCount: pending.count + processing.count,
    paidOutMinor: paid.amountMinor,
    paidPayoutCount: paid.count,
    failedPayoutMinor: failed.amountMinor,
    failedPayoutCount: failed.count,
    walletFloatMinor: sum(wallets._sum.balance),
    walletHeldMinor: sum(wallets._sum.heldBalance),
    depositsHeldMinor: sum(depositsHeld._sum.depositMinor),
    forfeitedDepositMinor: sum(forfeited._sum.depositMinor),
    forfeitedCount: forfeited._count,
    topupVolumeMinor: sum(topups._sum.amount),
    topupCount: topups._count,
    completedBookings,
    averageTicketMinor:
      completedBookings > 0
        ? Math.round(grossBookingsMinor / completedBookings)
        : 0,
    effectiveCommissionPercent:
      grossBookingsMinor > 0
        ? Number(((platformRevenueMinor / grossBookingsMinor) * 100).toFixed(2))
        : 0,
    monthly: buildMonthly(keys, monthlyGross, monthlyCommission),
    ...getCommissionRates(),
  };
};

export const SettlementEarnings = {
  getCommissionRates,
  getSalonEarnings,
  getPlatformEarnings,
};
