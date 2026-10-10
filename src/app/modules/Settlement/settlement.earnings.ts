import {
  LedgerAccount,
  PayoutStatus,
  Prisma,
  WalletTxType,
} from "@prisma/client";
import prisma from "../../shared/prisma";
import { getSettingSync } from "../../utils/settings";

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
const trendWindow = (range?: { from?: Date; to?: Date }) => {
  const now = range?.to ?? new Date();
  // A chosen range draws its own months, capped at two years of bars.
  const months = range?.from
    ? Math.min(
        24,
        Math.max(
          1,
          (now.getFullYear() - range.from.getFullYear()) * 12 +
            now.getMonth() -
            range.from.getMonth() +
            1,
        ),
      )
    : TREND_MONTHS;
  const start = new Date(
    now.getFullYear(),
    now.getMonth() - (months - 1),
    1,
  );

  const keys: string[] = [];
  for (let index = 0; index < months; index += 1) {
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
 * The one commission rate in force, as a percentage. Read from the same setting
 * the charging path reads, so a dashboard can state the rate without a second
 * copy of the number drifting out of step with what is billed.
 */
export const getCommissionRates = () => ({
  standardCommissionPercent: getSettingSync("booking.commissionPercent"),
});

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
export type EarningsRange = {
  from?: Date;
  to?: Date;
  /** Seed/test salons and users. Default true, so the old callers see everything. */
  includeTest?: boolean;
};

export const getPlatformEarnings = async (range: EarningsRange = {}) => {
  const { start, keys } = trendWindow(range);
  const includeTest = range.includeTest ?? true;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  // Flows (bookings, commission, top-ups) follow the range; balances (float,
  // held, payable, payouts) are what is true right now.
  const inRange =
    range.from || range.to
      ? { ...(range.from && { gte: range.from }), ...(range.to && { lte: range.to }) }
      : undefined;
  const realSalon = includeTest ? {} : { salon: { isTest: false } };
  const realUser = includeTest ? {} : { user: { isTest: false } };
  const realLedger = includeTest ? {} : { salon: { isTest: false } };
  const sqlFrom = range.from && range.from > start ? range.from : start;
  const sqlTo = range.to ?? new Date("9999-12-31T00:00:00Z");
  const sqlTest = includeTest ? Prisma.empty : Prisma.sql`AND s."isTest" = false`;

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
      where: { status: "COMPLETED", appointmentDate: inRange, ...realSalon },
      _sum: { totalMinor: true },
      _count: true,
    }),
    prisma.ledgerEntry.aggregate({
      where: { account: LedgerAccount.PLATFORM_REVENUE, createdAt: inRange, ...realLedger },
      _sum: { amountMinor: true },
    }),
    prisma.ledgerEntry.aggregate({
      where: {
        account: LedgerAccount.PLATFORM_REVENUE,
        createdAt: { gte: monthStart },
        ...realLedger,
      },
      _sum: { amountMinor: true },
    }),
    prisma.ledgerEntry.aggregate({
      where: {
        account: LedgerAccount.PLATFORM_REVENUE,
        createdAt: { gte: todayStart },
        ...realLedger,
      },
      _sum: { amountMinor: true },
    }),
    prisma.ledgerEntry.aggregate({
      where: { account: LedgerAccount.SALON_PAYABLE, payoutId: null, ...realLedger },
      _sum: { amountMinor: true },
    }),
    prisma.payout.groupBy({
      by: ["status"],
      where: realSalon,
      _sum: { netMinor: true },
      _count: true,
    }),
    // Customer money sitting with us. It is a liability, not revenue.
    prisma.wallet.aggregate({ where: realUser, _sum: { balance: true, heldBalance: true } }),
    prisma.walletTransaction.aggregate({
      where: {
        type: WalletTxType.TOPUP,
        createdAt: inRange,
        ...(includeTest ? {} : { wallet: { user: { isTest: false } } }),
      },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.appointment.aggregate({
      where: { depositStatus: "HELD", ...realSalon },
      _sum: { depositMinor: true },
    }),
    prisma.appointment.aggregate({
      where: { depositStatus: "FORFEITED", appointmentDate: inRange, ...realSalon },
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
      JOIN salons s ON s.id = a."salonId"
      WHERE a.status = 'COMPLETED'
        AND a."appointmentDate" >= ${sqlFrom}
        AND a."appointmentDate" <= ${sqlTo}
        ${sqlTest}
      GROUP BY 1
    `,
    prisma.$queryRaw<Array<{ month: string; commissionMinor: number }>>`
      SELECT to_char(date_trunc('month', a."appointmentDate"), 'YYYY-MM') AS month,
             COALESCE(SUM(l."amountMinor"), 0)::int AS "commissionMinor"
      FROM ledger_entries l
      JOIN appointments a ON a.id = l."appointmentId"
      JOIN salons s ON s.id = a."salonId"
      WHERE l.account = 'PLATFORM_REVENUE'
        AND a."appointmentDate" >= ${sqlFrom}
        AND a."appointmentDate" <= ${sqlTo}
        ${sqlTest}
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

/**
 * Money per Asia/Dhaka day, for analytics (`modules/Analytics`). The one place
 * those figures are defined, so the dashboard and the finance console agree:
 *
 *   gmvMinor          `totalMinor` of COMPLETED bookings, on the day they were
 *                     completed (`completedAt`, or the appointment date on rows
 *                     completed before that was stamped)
 *   commissionMinor   PLATFORM_REVENUE ledger entries by `createdAt`
 *   topupVolumeMinor  TOPUP wallet transactions by `createdAt`
 *
 * `from`/`to` are UTC instants (`to` exclusive). Without `includeTest`, test
 * salons and test customers are left out. `area`/`channel` narrow the booking
 * figures; top-ups have neither, so they come back empty when either is set.
 */
export type MoneyFilter = {
  from: Date;
  to: Date;
  includeTest: boolean;
  area?: string;
  channel?: string;
};

export type DailyMoney = {
  day: string;
  gmvMinor: number;
  completed: number;
  commissionMinor: number;
  topupVolumeMinor: number;
};

const utcTs = (at: Date) => Prisma.sql`(${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
const dhakaDay = (col: string) =>
  Prisma.raw(`to_char((${col} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD')`);
const COMPLETED_AT = `COALESCE(a."completedAt", a."appointmentDate")`;

const narrow = (f: MoneyFilter) =>
  Prisma.sql`${f.area ? Prisma.sql`AND lower(trim(s.area)) = ${f.area.trim().toLowerCase()}` : Prisma.empty}
    ${f.channel ? Prisma.sql`AND a."bookedVia"::text = ${f.channel}` : Prisma.empty}`;

const completedIn = (f: MoneyFilter) => Prisma.sql`
  a.status = 'COMPLETED'
  AND ${Prisma.raw(COMPLETED_AT)} >= ${utcTs(f.from)}
  AND ${Prisma.raw(COMPLETED_AT)} < ${utcTs(f.to)}
  ${f.includeTest ? Prisma.empty : Prisma.sql`AND s."isTest" = false AND u."isTest" = false`}
  ${narrow(f)}`;

export const getDailyMoney = async (f: MoneyFilter): Promise<DailyMoney[]> => {
  const [gmv, commission, topups] = await Promise.all([
    prisma.$queryRaw<Array<{ day: string; gmv: number; n: number }>>`
      SELECT ${dhakaDay(COMPLETED_AT)} AS day,
             COALESCE(SUM(a."totalMinor"), 0)::float AS gmv, COUNT(*)::int AS n
      FROM appointments a
      JOIN salons s ON s.id = a."salonId"
      JOIN users u ON u.id = a."customerId"
      WHERE ${completedIn(f)}
      GROUP BY 1`,
    // Without test data, rows whose salon was deleted (salonId set null) are
    // left out, as getPlatformEarnings does, so analytics and finance agree.
    prisma.$queryRaw<Array<{ day: string; v: number }>>`
      SELECT ${dhakaDay(`l."createdAt"`)} AS day, COALESCE(SUM(l."amountMinor"), 0)::float AS v
      FROM ledger_entries l
      LEFT JOIN salons s ON s.id = l."salonId"
      LEFT JOIN appointments a ON a.id = l."appointmentId"
      LEFT JOIN users u ON u.id = a."customerId"
      WHERE l.account = 'PLATFORM_REVENUE'
        AND l."createdAt" >= ${utcTs(f.from)} AND l."createdAt" < ${utcTs(f.to)}
        ${f.includeTest ? Prisma.empty : Prisma.sql`AND s."isTest" = false AND COALESCE(u."isTest", false) = false`}
        ${narrow(f)}
      GROUP BY 1`,
    f.area || f.channel
      ? Promise.resolve([] as Array<{ day: string; v: number }>)
      : prisma.$queryRaw<Array<{ day: string; v: number }>>`
      SELECT ${dhakaDay(`t."createdAt"`)} AS day, COALESCE(SUM(t.amount), 0)::float AS v
      FROM wallet_transactions t
      JOIN wallets w ON w.id = t."walletId"
      JOIN users u ON u.id = w."userId"
      WHERE t.type = 'TOPUP'
        AND t."createdAt" >= ${utcTs(f.from)} AND t."createdAt" < ${utcTs(f.to)}
        ${f.includeTest ? Prisma.empty : Prisma.sql`AND u."isTest" = false`}
      GROUP BY 1`,
  ]);

  const byDay = new Map<string, DailyMoney>();
  const row = (day: string) => {
    let r = byDay.get(day);
    if (!r) {
      r = { day, gmvMinor: 0, completed: 0, commissionMinor: 0, topupVolumeMinor: 0 };
      byDay.set(day, r);
    }
    return r;
  };
  for (const g of gmv) Object.assign(row(g.day), { gmvMinor: g.gmv, completed: g.n });
  for (const c of commission) row(c.day).commissionMinor = c.v;
  for (const t of topups) row(t.day).topupVolumeMinor = t.v;
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
};

/** Completed GMV over a range, grouped by salon area (the geo report). */
export const getMoneyByArea = (f: MoneyFilter) =>
  prisma.$queryRaw<Array<{ area: string; district: string; gmvMinor: number; completed: number }>>`
    SELECT s.area, s.district, COALESCE(SUM(a."totalMinor"), 0)::float AS "gmvMinor",
           COUNT(*)::int AS completed
    FROM appointments a
    JOIN salons s ON s.id = a."salonId"
    JOIN users u ON u.id = a."customerId"
    WHERE ${completedIn(f)}
    GROUP BY 1, 2
    ORDER BY 3 DESC`;

/** The salons with the most completed GMV over a range. */
export const getMoneyBySalon = (f: MoneyFilter, limit = 20) =>
  prisma.$queryRaw<Array<{ salonId: string; name: string; area: string; gmvMinor: number; completed: number }>>`
    SELECT s.id AS "salonId", s.name, s.area,
           COALESCE(SUM(a."totalMinor"), 0)::float AS "gmvMinor", COUNT(*)::int AS completed
    FROM appointments a
    JOIN salons s ON s.id = a."salonId"
    JOIN users u ON u.id = a."customerId"
    WHERE ${completedIn(f)}
    GROUP BY 1, 2, 3
    ORDER BY 4 DESC
    LIMIT ${limit}`;

export const SettlementEarnings = {
  getCommissionRates,
  getSalonEarnings,
  getPlatformEarnings,
  getDailyMoney,
  getMoneyByArea,
  getMoneyBySalon,
};
