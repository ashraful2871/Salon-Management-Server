import { Request, Response } from "express";
import { BookingPause, LedgerAccount, PayoutAccountStatus, PayoutStatus, Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import ApiError from "../../Error/error";
import catchAsync from "../../shared/catchAsync";
import prisma from "../../shared/prisma";
import sendResponse from "../../shared/sendResponse";
import { CsvColumn, streamCsv } from "../../utils/csv";
import { assertOwnerOf, withAccessCache } from "../../utils/salonAccess";
import { getSetting } from "../../utils/settings";
import { getOwnerBuckets, holdCutoff, IN_PAYOUT } from "../Settlement/settlement.buckets";
import { getSalonEarnings } from "../Settlement/settlement.earnings";
import { destinationLabel } from "../Settlement/settlement.service";
import { describeAccount } from "./owner.payoutAccount";
import { DUES_PAID_DESCRIPTION, DUES_WAIVED_DESCRIPTION, MIN_DUES_PAYMENT_MINOR } from "../Settlement/settlement.dues";
import { PaymentIntentService } from "../Payment/paymentIntent.service";

/**
 * The owner's Money hub: where every taka of SALON_PAYABLE sits and why. All
 * reads are scoped to the caller's business (assertOwnerOf), so a foreign
 * payout id is a 404 and a foreign `salonId` simply matches nothing.
 */

// ---------------------------------------------------------------- types

/**
 * A ledger line's type, read off its description - each writer in
 * settlement.service uses one fixed description per SALON_PAYABLE leg, so the
 * mapping is exact. Anything not listed (manual corrections, old rows) is a
 * payout adjustment. `dues` has no writer yet (owner Phase 6).
 */
export const TRANSACTION_TYPES = [
  "booking",
  "no_show",
  "late_cancel",
  "commission",
  "goodwill",
  "dues",
  "payout_adjustment",
] as const;
type TransactionType = (typeof TRANSACTION_TYPES)[number];

const TYPE_DESCRIPTIONS: Record<Exclude<TransactionType, "payout_adjustment">, string[]> = {
  booking: ["Deposit owed to salon"],
  no_show: ["Salon share of forfeited deposit", "Salon share reversed on appeal"],
  late_cancel: ["Late cancellation fee kept by salon"],
  commission: ["Platform commission deducted"],
  goodwill: ["Goodwill credit funded by salon"],
  dues: [DUES_PAID_DESCRIPTION, DUES_WAIVED_DESCRIPTION],
};

const KNOWN_DESCRIPTIONS = Object.values(TYPE_DESCRIPTIONS).flat();

const TYPE_BY_DESCRIPTION = new Map<string, TransactionType>(
  Object.entries(TYPE_DESCRIPTIONS).flatMap(([type, list]) =>
    list.map((description) => [description, type as TransactionType] as const),
  ),
);

const typeOf = (description: string): TransactionType =>
  TYPE_BY_DESCRIPTION.get(description) ?? "payout_adjustment";

const typeWhere = (type?: TransactionType): Prisma.LedgerEntryWhereInput => {
  if (!type) return {};
  if (type === "payout_adjustment") return { description: { notIn: KNOWN_DESCRIPTIONS } };
  return { description: { in: TYPE_DESCRIPTIONS[type] } };
};

// ---------------------------------------------------------------- query parsing

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const transactionsQuery = z.object({
  salonId: z.string().trim().min(1).optional(),
  type: z.enum(TRANSACTION_TYPES).optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

const payoutsQuery = z.object({
  status: z.nativeEnum(PayoutStatus).optional(),
  salonId: z.string().trim().min(1).optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const parse = <T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> => {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(StatusCodes.BAD_REQUEST, result.error.issues[0]?.message ?? "Invalid query");
  }
  return result.data;
};

/** Midnight Asia/Dhaka of a `YYYY-MM-DD` day (no DST in Dhaka). */
const dhakaDay = (day: string) => new Date(`${day}T00:00:00+06:00`);

const dhakaMonthStart = (now = new Date()) =>
  dhakaDay(`${new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString().slice(0, 7)}-01`);

// ---------------------------------------------------------------- rows

const ENTRY_SELECT = {
  id: true,
  createdAt: true,
  description: true,
  amountMinor: true,
  payoutId: true,
  salonId: true,
  salon: { select: { name: true } },
  payout: { select: { status: true } },
  appointment: { select: { id: true, token: true, service: { select: { name: true } } } },
} satisfies Prisma.LedgerEntrySelect;

type EntryRow = Prisma.LedgerEntryGetPayload<{ select: typeof ENTRY_SELECT }>;

/** Same split as getOwnerBuckets, per row. */
const bucketOf = (row: EntryRow, cutoff: Date) => {
  if (!row.payoutId || !row.payout) return row.createdAt > cutoff ? "pending" : "available";
  if (row.payout.status === PayoutStatus.PAID) return "paid";
  return IN_PAYOUT.includes(row.payout.status) ? "in_payout" : "available";
};

const toTransaction = (row: EntryRow, cutoff: Date) => ({
  id: row.id,
  createdAt: row.createdAt,
  salonId: row.salonId,
  salonName: row.salon?.name ?? "Deleted branch",
  type: typeOf(row.description),
  description: row.description,
  amountMinor: row.amountMinor,
  bucket: bucketOf(row, cutoff),
  appointment: row.appointment
    ? {
        id: row.appointment.id,
        token: row.appointment.token,
        serviceName: row.appointment.service?.name ?? null,
      }
    : null,
  payoutId: row.payoutId,
});

const transactionsWhere = (
  ownerId: string,
  q: { salonId?: string; type?: TransactionType; from?: string; to?: string },
): Prisma.LedgerEntryWhereInput => ({
  ownerId,
  account: LedgerAccount.SALON_PAYABLE,
  ...(q.salonId && { salonId: q.salonId }),
  ...typeWhere(q.type),
  ...((q.from || q.to) && {
    createdAt: {
      ...(q.from && { gte: dhakaDay(q.from) }),
      // `to` is inclusive: everything before the next Dhaka midnight.
      ...(q.to && { lt: new Date(dhakaDay(q.to).getTime() + 24 * 60 * 60 * 1000) }),
    },
  }),
});

const NEWEST_FIRST = [{ createdAt: "desc" }, { id: "desc" }] satisfies Prisma.LedgerEntryOrderByWithRelationInput[];

const ownerOf = (req: Request) => assertOwnerOf(withAccessCache(req));

const ok = (res: Response, message: string, data: unknown) =>
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message, data });

// ---------------------------------------------------------------- endpoints

/** GET /owner/money/summary?salonId - buckets, last payout, account, rates, trend. */
const summary = catchAsync(async (req: Request, res: Response) => {
  const { ownerId, salonIds } = await ownerOf(req);
  const salonId = typeof req.query.salonId === "string" && req.query.salonId ? req.query.salonId : undefined;
  // A foreign branch matches no ledger row (they are filtered by ownerId too).
  const trendSalons = salonId ? salonIds.filter((id) => id === salonId) : salonIds;

  const [buckets, paidThisMonth, lastPayout, accounts, owner, commissionPercent, commissionOnDirect, earnings] =
    await Promise.all([
      getOwnerBuckets(ownerId, { salonId }),
      prisma.ledgerEntry.aggregate({
        where: {
          ownerId,
          account: LedgerAccount.SALON_PAYABLE,
          ...(salonId && { salonId }),
          payout: { status: PayoutStatus.PAID, paidAt: { gte: dhakaMonthStart() } },
        },
        _sum: { amountMinor: true },
      }),
      prisma.payout.findFirst({
        where: {
          ownerId,
          status: { not: PayoutStatus.CANCELLED },
          ...(salonId && { entries: { some: { salonId } } }),
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.payoutAccount.findMany({
        where: { ownerId, status: { not: PayoutAccountStatus.DISABLED } },
        orderBy: { createdAt: "desc" },
        take: 5,
      }),
      prisma.salonOwner.findUnique({
        where: { id: ownerId },
        select: { payoutsFrozen: true, duesSince: true, duesWarnedAt: true },
      }),
      getSetting("booking.commissionPercent"),
      getSetting("booking.commissionOnDirect"),
      getSalonEarnings(trendSalons),
    ]);

  // The verified account is the one paid; otherwise show what is in progress.
  const account =
    accounts.find((a) => a.status === PayoutAccountStatus.VERIFIED) ?? accounts[0] ?? null;

  // Dues are paid business-wide, whatever branch the page is filtered to.
  const [businessDues, pausedSalons, pauseEnabled] = await Promise.all([
    salonId ? getOwnerBuckets(ownerId).then((b) => b.duesMinor) : Promise.resolve(buckets.duesMinor),
    prisma.salon.findMany({
      where: { ownerId, isDeleted: false, bookingPause: BookingPause.DUES },
      select: { bookingPausedAt: true },
    }),
    getSetting("dues.pauseEnabled"),
  ]);
  const warnedAt = owner?.duesWarnedAt ?? null;

  ok(res, "Money summary", {
    ...buckets,
    paidThisMonthMinor: paidThisMonth._sum.amountMinor ?? 0,
    lastPayout: lastPayout && {
      id: lastPayout.id,
      netMinor: lastPayout.netMinor,
      status: lastPayout.status,
      createdAt: lastPayout.createdAt,
      paidAt: lastPayout.paidAt,
      destination: destinationLabel(lastPayout.destinationSnapshot),
      failureReason: lastPayout.failureReason,
    },
    account: account && {
      id: account.id,
      status: account.status,
      label: describeAccount(account),
      cooldownUntil: account.cooldownUntil,
    },
    payoutsFrozen: owner?.payoutsFrozen ?? false,
    dues: {
      amountMinor: businessDues,
      since: owner?.duesSince ?? null,
      minPayMinor: MIN_DUES_PAYMENT_MINOR,
      pauseEnabled,
      pauseAt: !pausedSalons.length && warnedAt ? new Date(warnedAt.getTime() + 3 * 24 * 60 * 60 * 1000) : null,
      paused: pausedSalons.length > 0,
      pausedSalons: pausedSalons.length,
      pausedAt: pausedSalons[0]?.bookingPausedAt ?? null,
    },
    commissionPercent,
    commissionOnDirect,
    monthly: earnings.monthly,
  });
});

/** GET /owner/money/transactions - SALON_PAYABLE lines, newest first, by cursor. */
const transactions = catchAsync(async (req: Request, res: Response) => {
  const { ownerId } = await ownerOf(req);
  const q = parse(transactionsQuery, req.query);
  const cutoff = holdCutoff(await getSetting("payouts.holdDays"));

  const rows = await prisma.ledgerEntry.findMany({
    where: transactionsWhere(ownerId, q),
    orderBy: NEWEST_FIRST,
    take: q.limit + 1,
    ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
    select: ENTRY_SELECT,
  });

  const page = rows.slice(0, q.limit);
  ok(res, "Transactions", {
    items: page.map((row) => toTransaction(row, cutoff)),
    nextCursor: rows.length > q.limit ? page[page.length - 1].id : null,
  });
});

/** GET /owner/money/transactions.csv - same filters, outside the envelope. */
const transactionsCsv = catchAsync(async (req: Request, res: Response) => {
  const { ownerId } = await ownerOf(req);
  const q = parse(transactionsQuery, req.query);
  const cutoff = holdCutoff(await getSetting("payouts.holdDays"));
  const where = transactionsWhere(ownerId, q);

  type Line = ReturnType<typeof toTransaction>;
  const columns: CsvColumn<Line>[] = [
    { header: "date", value: (t) => t.createdAt },
    { header: "branch", value: (t) => t.salonName },
    { header: "type", value: (t) => t.type },
    { header: "description", value: (t) => t.description },
    { header: "amount_taka", value: (t) => t.amountMinor, money: true },
    { header: "status", value: (t) => t.bucket },
    { header: "booking_token", value: (t) => t.appointment?.token ?? "" },
    { header: "service", value: (t) => t.appointment?.serviceName ?? "" },
    { header: "payout_id", value: (t) => t.payoutId ?? "" },
  ];

  await streamCsv(res, {
    filename: `transactions-${new Date().toISOString().slice(0, 10)}.csv`,
    columns,
    // The owner's own lines; there is no customer PII in them.
    showPii: true,
    fetchBatch: async (after, take) => {
      const rows = await prisma.ledgerEntry.findMany({
        where,
        orderBy: NEWEST_FIRST,
        take,
        ...(after && { cursor: { id: after.id }, skip: 1 }),
        select: ENTRY_SELECT,
      });
      return rows.map((row) => toTransaction(row, cutoff));
    },
  });
});

const payoutRow = (
  p: Prisma.PayoutGetPayload<{ include: { salon: { select: { name: true } }; _count: { select: { entries: true } } } }>,
) => ({
  id: p.id,
  status: p.status,
  periodStart: p.periodStart,
  periodEnd: p.periodEnd,
  grossMinor: p.grossMinor,
  commissionMinor: p.commissionMinor,
  netMinor: p.netMinor,
  method: p.method,
  reference: p.reference,
  destination: destinationLabel(p.destinationSnapshot),
  failureReason: p.failureReason,
  cancelledReason: p.cancelledReason,
  paidAt: p.paidAt,
  createdAt: p.createdAt,
  salonName: p.salonId ? (p.salon?.name ?? "Deleted branch") : null,
  entryCount: p._count.entries,
});

const PAYOUT_INCLUDE = {
  salon: { select: { name: true } },
  _count: { select: { entries: true } },
} as const;

/** GET /owner/money/payouts?status&salonId&cursor - the business's payouts, newest first. */
const payouts = catchAsync(async (req: Request, res: Response) => {
  const { ownerId } = await ownerOf(req);
  const q = parse(payoutsQuery, req.query);

  const rows = await prisma.payout.findMany({
    where: {
      ownerId,
      ...(q.status && { status: q.status }),
      ...(q.salonId && { entries: { some: { salonId: q.salonId } } }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
    ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
    include: PAYOUT_INCLUDE,
  });

  const page = rows.slice(0, q.limit);
  ok(res, "Payouts", {
    items: page.map(payoutRow),
    nextCursor: rows.length > q.limit ? page[page.length - 1].id : null,
  });
});

/** GET /owner/money/payouts/:id - one payout and its lines grouped by branch. */
const payout = catchAsync(async (req: Request, res: Response) => {
  const { ownerId } = await ownerOf(req);
  const found = await prisma.payout.findFirst({
    where: { id: req.params.id, ownerId },
    include: PAYOUT_INCLUDE,
  });
  if (!found) throw new ApiError(StatusCodes.NOT_FOUND, "Not found");

  const [entries, holdDays] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: { payoutId: found.id, account: LedgerAccount.SALON_PAYABLE },
      orderBy: NEWEST_FIRST,
      select: ENTRY_SELECT,
    }),
    getSetting("payouts.holdDays"),
  ]);
  const cutoff = holdCutoff(holdDays);

  const groups = new Map<string, { salonId: string | null; salonName: string; totalMinor: number; entries: ReturnType<typeof toTransaction>[] }>();
  for (const row of entries) {
    const line = toTransaction(row, cutoff);
    const key = row.salonId ?? "none";
    const group = groups.get(key) ?? { salonId: row.salonId, salonName: line.salonName, totalMinor: 0, entries: [] };
    group.totalMinor += line.amountMinor;
    group.entries.push(line);
    groups.set(key, group);
  }

  ok(res, "Payout", {
    ...payoutRow(found),
    entriesTotalMinor: entries.reduce((sum, e) => sum + e.amountMinor, 0),
    branches: [...groups.values()].sort((a, b) => a.salonName.localeCompare(b.salonName)),
  });
});


const payDuesBody = z.object({ provider: z.enum(["BKASH", "SSLCOMMERZ"]).default("BKASH") });

/**
 * POST /owner/dues/pay { provider } - the server decides the amount (current
 * dues); returns the gateway URL. Success/fail/cancel land back on
 * /dashboard/money?dues=…
 */
const payDues = catchAsync(async (req: Request, res: Response) => {
  const { ownerId } = await ownerOf(req);
  const { provider } = parse(payDuesBody, req.body ?? {});
  const result = await PaymentIntentService.initiateDuesPayment(req.user!.userId, ownerId, provider);
  ok(res, "Payment session created", result);
});

export const OwnerMoney = { summary, transactions, transactionsCsv, payouts, payout, payDues };
