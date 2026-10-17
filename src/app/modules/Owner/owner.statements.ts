import { createHash } from "crypto";
import { Request, Response } from "express";
import { LedgerAccount, PaymentStatus, PayoutStatus, Prisma, StatementKind } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import ApiError from "../../Error/error";
import catchAsync from "../../shared/catchAsync";
import prisma from "../../shared/prisma";
import sendResponse from "../../shared/sendResponse";
import { CsvColumn, CSV_MAX_ROWS, streamCsv } from "../../utils/csv";
import { assertOwnerOf, withAccessCache } from "../../utils/salonAccess";
import { getSetting } from "../../utils/settings";
import { dayStart, dhakaDay } from "../Analytics/analytics.days";
import { destinationLabel } from "../Settlement/settlement.service";
import { TYPE_DESCRIPTIONS, typeOf } from "./owner.money";

/**
 * Owner statements (owner Phase 7): immutable snapshots of the ledger an owner
 * can hand to an accountant.
 *
 * - MONTHLY: a Dhaka month of the business's SALON_PAYABLE. "Balance" is what
 *   the platform owes the business = Σ SALON_PAYABLE − Σ lines of PAID payouts
 *   (getOwnerBuckets' pending + available + in payout). opening + every
 *   movement must equal closing, or the statement is not stored.
 * - INVOICE: the month's commission per branch, numbered SK-<yyyy>-<000123>
 *   from the Postgres sequence `owner_invoice_seq`. VAT is *inside* the
 *   commission (finance.vatPercent), so the total always equals the ledger.
 * - PAYOUT: written in the PAID transition (transitionPayout).
 *
 * `ledgerHash` = sha256 of the sorted "id:amountMinor" lines a statement
 * covers; rebuilding from the ledger must give the same hash.
 */

const INVOICE_SEQUENCE = "owner_invoice_seq";
const RUN_HOUR_DHAKA = 3;

// ---------------------------------------------------------------- months

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export const isMonth = (s: unknown): s is string => typeof s === "string" && MONTH.test(s);

const nextMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/** The Dhaka month before the one containing `now`, "YYYY-MM". */
export const previousMonth = (now = new Date()) => {
  const [y, m] = dhakaDay(now).split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

/** Dhaka month bounds; periodEnd is exclusive. */
export const monthBounds = (month: string) => ({
  periodStart: dayStart(`${month}-01`),
  periodEnd: dayStart(`${nextMonth(month)}-01`),
});

const monthOf = (periodStart: Date) => dhakaDay(periodStart).slice(0, 7);

const monthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

// ---------------------------------------------------------------- shared

type Db = Prisma.TransactionClient | typeof prisma;

const PAYABLE = LedgerAccount.SALON_PAYABLE;

export const ledgerHash = (lines: string[]) =>
  createHash("sha256").update([...lines].sort().join("\n")).digest("hex");

/** What the platform owes the business at `before`: Σ payable − Σ paid out. */
export const balanceAt = async (db: Db, ownerId: string, before: Date) => {
  const [all, paid] = await Promise.all([
    db.ledgerEntry.aggregate({
      where: { ownerId, account: PAYABLE, createdAt: { lt: before } },
      _sum: { amountMinor: true },
    }),
    db.ledgerEntry.aggregate({
      where: { ownerId, account: PAYABLE, payout: { status: PayoutStatus.PAID, paidAt: { lt: before } } },
      _sum: { amountMinor: true },
    }),
  ]);
  return (all._sum.amountMinor ?? 0) - (paid._sum.amountMinor ?? 0);
};

/** Ledger type → monthly total field. A salon refund (Phase 15) is an adjustment. */
const FIELD_BY_TYPE = {
  booking: "depositsAppliedMinor",
  prepaid: "prepaidMinor",
  refund: "adjustmentsMinor",
  no_show: "noShowShareMinor",
  late_cancel: "lateCancelMinor",
  commission: "commissionMinor",
  goodwill: "goodwillMinor",
  dues: "duesPaidMinor",
  payout_adjustment: "adjustmentsMinor",
} as const;

const MOVEMENT_FIELDS = [
  "depositsAppliedMinor",
  "noShowShareMinor",
  "lateCancelMinor",
  "prepaidMinor",
  "commissionMinor",
  "goodwillMinor",
  "duesPaidMinor",
  "payoutsMinor",
  "adjustmentsMinor",
] as const;
type MovementField = (typeof MOVEMENT_FIELDS)[number];
type Movements = Record<MovementField, number>;

const zeroMovements = (): Movements =>
  Object.fromEntries(MOVEMENT_FIELDS.map((f) => [f, 0])) as Movements;

const salonNames = async (db: Db, ids: (string | null)[]) => {
  const real = [...new Set(ids)].filter((id): id is string => !!id);
  const rows = real.length
    ? await db.salon.findMany({ where: { id: { in: real } }, select: { id: true, name: true } })
    : [];
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  return (id: string | null) => (id ? (byId.get(id) ?? "Deleted branch") : "Deleted branch");
};

/** Stores a statement once per (owner, kind, periodStart); a replay returns the row. */
const storeOnce = async (
  db: Db,
  data: Omit<Prisma.OwnerStatementUncheckedCreateInput, "number">,
  numbered = false,
) => {
  const key = { ownerId: data.ownerId, kind: data.kind, periodStart: data.periodStart as Date };
  const existing = await db.ownerStatement.findUnique({ where: { ownerId_kind_periodStart: key } });
  if (existing) return { statement: existing, created: false };

  let number: string | undefined;
  if (numbered) {
    // A sequence value is never handed out twice, even if this insert loses.
    const [{ n }] = await db.$queryRaw<{ n: bigint }[]>`SELECT nextval(${INVOICE_SEQUENCE}::regclass) AS n`;
    number = `SK-${dhakaDay().slice(0, 4)}-${String(n).padStart(6, "0")}`;
  }
  try {
    return { statement: await db.ownerStatement.create({ data: { ...data, number } }), created: true };
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error;
    const row = await db.ownerStatement.findUnique({ where: { ownerId_kind_periodStart: key } });
    if (!row) throw error;
    return { statement: row, created: false };
  }
};

const assertMonthEnded = (month: string) => {
  if (!isMonth(month)) throw new ApiError(StatusCodes.BAD_REQUEST, "month must be YYYY-MM");
  const bounds = monthBounds(month);
  if (bounds.periodEnd > new Date()) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "A statement is made only after the month has ended");
  }
  return bounds;
};

// ---------------------------------------------------------------- monthly

/** The month's totals from the ledger, without storing anything. */
export const computeMonthly = async (ownerId: string, month: string, db: Db = prisma) => {
  const { periodStart, periodEnd } = assertMonthEnded(month);
  const inMonth = { gte: periodStart, lt: periodEnd };

  const [entries, paidLines, counter, openingMinor, closingMinor] = await Promise.all([
    db.ledgerEntry.findMany({
      where: { ownerId, account: PAYABLE, createdAt: inMonth },
      select: { id: true, amountMinor: true, description: true, salonId: true },
    }),
    db.ledgerEntry.findMany({
      where: { ownerId, account: PAYABLE, payout: { status: PayoutStatus.PAID, paidAt: inMonth } },
      select: { id: true, amountMinor: true, payoutId: true },
    }),
    db.payment.aggregate({
      where: {
        status: PaymentStatus.COMPLETED,
        appointment: { salon: { ownerId }, completedAt: inMonth },
      },
      _sum: { amountMinor: true },
    }),
    balanceAt(db, ownerId, periodStart),
    balanceAt(db, ownerId, periodEnd),
  ]);

  const nameOf = await salonNames(db, entries.map((e) => e.salonId));
  const totals = zeroMovements();
  const perSalon = new Map<string, Movements & { salonId: string | null; salonName: string; netMinor: number }>();

  for (const entry of entries) {
    const field = FIELD_BY_TYPE[typeOf(entry.description)];
    totals[field] += entry.amountMinor;
    const key = entry.salonId ?? "none";
    const row = perSalon.get(key) ?? {
      salonId: entry.salonId,
      salonName: nameOf(entry.salonId),
      netMinor: 0,
      ...zeroMovements(),
    };
    row[field] += entry.amountMinor;
    row.netMinor += entry.amountMinor;
    perSalon.set(key, row);
  }
  // Paid-out money leaves the balance on the day the payout is marked paid.
  totals.payoutsMinor = -paidLines.reduce((sum, line) => sum + line.amountMinor, 0);

  const movementMinor = MOVEMENT_FIELDS.reduce((sum, f) => sum + totals[f], 0);
  const balanced = openingMinor + movementMinor === closingMinor;

  return {
    ownerId,
    periodStart,
    periodEnd,
    balanced,
    ledgerHash: ledgerHash([
      ...entries.map((e) => `E:${e.id}:${e.amountMinor}`),
      ...paidLines.map((p) => `P:${p.id}:${p.amountMinor}`),
    ]),
    totals: {
      month,
      openingMinor,
      ...totals,
      closingMinor,
      counterCollectedMinor: counter._sum.amountMinor ?? 0,
      entryCount: entries.length,
      payoutIds: [...new Set(paidLines.map((p) => p.payoutId))].sort(),
      perSalon: [...perSalon.values()].sort((a, b) => a.salonName.localeCompare(b.salonName)),
    },
  };
};

/** Builds and stores the month's statement (idempotent); refuses one that does not reconcile. */
export const buildMonthly = async (ownerId: string, month: string, db: Db = prisma) => {
  const built = await computeMonthly(ownerId, month, db);
  if (!built.balanced) {
    throw new ApiError(
      StatusCodes.INTERNAL_SERVER_ERROR,
      `Statement ${month} for owner ${ownerId} does not reconcile: opening + movements ≠ closing`,
    );
  }
  return storeOnce(db, {
    ownerId,
    kind: StatementKind.MONTHLY,
    periodStart: built.periodStart,
    periodEnd: built.periodEnd,
    totals: built.totals,
    ledgerHash: built.ledgerHash,
  });
};

// ---------------------------------------------------------------- invoice

/** The month's commission per branch; null when there is none to invoice. */
export const computeInvoice = async (ownerId: string, month: string, db: Db = prisma) => {
  const { periodStart, periodEnd } = assertMonthEnded(month);

  const [entries, owner, legalName, bin, vatRatePercent] = await Promise.all([
    db.ledgerEntry.findMany({
      where: {
        ownerId,
        account: PAYABLE,
        description: { in: TYPE_DESCRIPTIONS.commission },
        createdAt: { gte: periodStart, lt: periodEnd },
      },
      select: { id: true, amountMinor: true, salonId: true, appointmentId: true },
    }),
    db.salonOwner.findUniqueOrThrow({
      where: { id: ownerId },
      select: {
        businessName: true,
        legalName: true,
        businessAddress: true,
        bin: true,
        tin: true,
        user: { select: { name: true } },
      },
    }),
    getSetting("finance.legalName"),
    getSetting("finance.bin"),
    getSetting("finance.vatPercent"),
  ]);

  const nameOf = await salonNames(db, entries.map((e) => e.salonId));
  const lines = new Map<string, { salonId: string | null; salonName: string; bookings: Set<string>; commissionMinor: number }>();
  for (const entry of entries) {
    const key = entry.salonId ?? "none";
    const line = lines.get(key) ?? { salonId: entry.salonId, salonName: nameOf(entry.salonId), bookings: new Set(), commissionMinor: 0 };
    // Commission is a debit on SALON_PAYABLE; on the invoice it is a charge.
    line.commissionMinor -= entry.amountMinor;
    if (entry.appointmentId) line.bookings.add(entry.appointmentId);
    lines.set(key, line);
  }

  const subtotalMinor = [...lines.values()].reduce((sum, l) => sum + l.commissionMinor, 0);
  if (subtotalMinor <= 0) return null;

  // VAT is included in the commission already taken, never added on top.
  const vatMinor = Math.round((subtotalMinor * vatRatePercent) / (100 + vatRatePercent));

  return {
    ownerId,
    periodStart,
    periodEnd,
    ledgerHash: ledgerHash(entries.map((e) => `C:${e.id}:${e.amountMinor}`)),
    totals: {
      month,
      seller: { legalName, bin: bin || null },
      buyer: {
        businessName: owner.businessName ?? owner.user.name,
        legalName: owner.legalName,
        address: owner.businessAddress,
        bin: owner.bin,
        tin: owner.tin,
      },
      lines: [...lines.values()]
        .sort((a, b) => a.salonName.localeCompare(b.salonName))
        .map((l) => ({ salonId: l.salonId, salonName: l.salonName, bookings: l.bookings.size, commissionMinor: l.commissionMinor })),
      subtotalMinor,
      vatRatePercent,
      vatMinor,
      netOfVatMinor: subtotalMinor - vatMinor,
      totalMinor: subtotalMinor,
      entryCount: entries.length,
    },
  };
};

/** Builds, numbers and stores the month's invoice (idempotent); null when no commission. */
export const buildInvoice = async (ownerId: string, month: string, db: Db = prisma) => {
  const built = await computeInvoice(ownerId, month, db);
  if (!built) return null;
  return storeOnce(
    db,
    {
      ownerId,
      kind: StatementKind.INVOICE,
      periodStart: built.periodStart,
      periodEnd: built.periodEnd,
      totals: built.totals,
      ledgerHash: built.ledgerHash,
    },
    true,
  );
};

// ---------------------------------------------------------------- payout

/** The payout's lines from the ledger, without storing anything. */
export const computePayoutStatement = async (db: Db, payoutId: string) => {
  const payout = await db.payout.findUniqueOrThrow({ where: { id: payoutId } });
  const entries = await db.ledgerEntry.findMany({
    where: { payoutId, account: PAYABLE },
    select: { id: true, amountMinor: true, description: true, salonId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const nameOf = await salonNames(db, entries.map((e) => e.salonId));

  const byType = zeroMovements();
  const perSalon = new Map<string, { salonId: string | null; salonName: string; entryCount: number; netMinor: number }>();
  for (const entry of entries) {
    byType[FIELD_BY_TYPE[typeOf(entry.description)]] += entry.amountMinor;
    const key = entry.salonId ?? "none";
    const row = perSalon.get(key) ?? { salonId: entry.salonId, salonName: nameOf(entry.salonId), entryCount: 0, netMinor: 0 };
    row.entryCount += 1;
    row.netMinor += entry.amountMinor;
    perSalon.set(key, row);
  }
  const entriesTotalMinor = entries.reduce((sum, e) => sum + e.amountMinor, 0);
  if (entriesTotalMinor !== payout.netMinor) {
    console.error(`[statements] payout ${payoutId}: lines ${entriesTotalMinor} ≠ net ${payout.netMinor}`);
  }
  // A payout's own lines carry no "paid out" movement.
  const types: Partial<Movements> = { ...byType };
  delete types.payoutsMinor;

  return {
    payout,
    periodStart: payout.periodStart ?? entries[0]?.createdAt ?? payout.createdAt,
    periodEnd: payout.periodEnd ?? payout.paidAt ?? new Date(),
    ledgerHash: ledgerHash(entries.map((e) => `E:${e.id}:${e.amountMinor}`)),
    totals: {
      reference: `SK-PO-${payout.id.slice(0, 8).toUpperCase()}`,
      grossMinor: payout.grossMinor,
      commissionMinor: payout.commissionMinor,
      payoutNetMinor: payout.netMinor,
      // The statement is the ledger: its net is the lines' sum.
      netMinor: entriesTotalMinor,
      ...types,
      method: payout.method,
      bankReference: payout.reference,
      destination: destinationLabel(payout.destinationSnapshot),
      paidAt: payout.paidAt,
      entryCount: entries.length,
      perSalon: [...perSalon.values()].sort((a, b) => a.salonName.localeCompare(b.salonName)),
    },
  };
};

/**
 * Called inside the PAID transition (same transaction). One statement per
 * payout; a second call returns the first.
 */
export const writePayoutStatement = async (db: Prisma.TransactionClient, payoutId: string) => {
  const existing = await db.ownerStatement.findUnique({ where: { payoutId } });
  if (existing) return existing;

  const built = await computePayoutStatement(db, payoutId);
  // (owner, PAYOUT, periodStart) is unique: two payouts starting on the same
  // instant get the later one nudged by a millisecond.
  let periodStart = built.periodStart;
  while (
    await db.ownerStatement.findUnique({
      where: { ownerId_kind_periodStart: { ownerId: built.payout.ownerId, kind: StatementKind.PAYOUT, periodStart } },
      select: { id: true },
    })
  ) {
    periodStart = new Date(periodStart.getTime() + 1);
  }

  return db.ownerStatement.create({
    data: {
      ownerId: built.payout.ownerId,
      kind: StatementKind.PAYOUT,
      payoutId,
      periodStart,
      periodEnd: built.periodEnd,
      totals: built.totals,
      ledgerHash: built.ledgerHash,
    },
  });
};

// ---------------------------------------------------------------- job

/**
 * Job `statements.monthly`, hourly. From 03:00 Dhaka on the 1st it makes last
 * month's MONTHLY statement (and INVOICE, when there was commission) for every
 * business with a ledger line or a paid payout in it. Idempotent through the
 * (owner, kind, periodStart) key, so later runs only fill what is missing.
 */
export const runMonthlyStatements = async (now = new Date()) => {
  const clock = new Date(now.getTime() + 6 * 60 * 60 * 1000);
  if (clock.getUTCDate() === 1 && clock.getUTCHours() < RUN_HOUR_DHAKA) {
    return { ran: false, reason: "before 03:00 Dhaka on the 1st" };
  }

  const month = previousMonth(now);
  const { periodStart, periodEnd } = monthBounds(month);
  const inMonth = { gte: periodStart, lt: periodEnd };

  const [withEntries, withPayouts, withCommission, done] = await Promise.all([
    prisma.ledgerEntry.groupBy({
      by: ["ownerId"],
      where: { account: PAYABLE, ownerId: { not: null }, createdAt: inMonth },
    }),
    prisma.payout.groupBy({ by: ["ownerId"], where: { status: PayoutStatus.PAID, paidAt: inMonth } }),
    prisma.ledgerEntry.groupBy({
      by: ["ownerId"],
      where: { account: PAYABLE, ownerId: { not: null }, description: { in: TYPE_DESCRIPTIONS.commission }, createdAt: inMonth },
      _sum: { amountMinor: true },
    }),
    prisma.ownerStatement.findMany({
      where: { periodStart, kind: { in: [StatementKind.MONTHLY, StatementKind.INVOICE] } },
      select: { ownerId: true, kind: true },
    }),
  ]);

  const has = new Set(done.map((s) => `${s.kind}:${s.ownerId}`));
  const monthlyFor = [...new Set([...withEntries.map((r) => r.ownerId!), ...withPayouts.map((r) => r.ownerId)])].filter(
    (id) => !has.has(`MONTHLY:${id}`),
  );
  const invoiceFor = withCommission
    .filter((r) => (r._sum.amountMinor ?? 0) < 0 && !has.has(`INVOICE:${r.ownerId}`))
    .map((r) => r.ownerId!);

  const tally = { monthly: 0, invoices: 0, errors: 0 };
  for (const ownerId of monthlyFor) {
    try {
      if ((await buildMonthly(ownerId, month)).created) tally.monthly += 1;
    } catch (err) {
      console.error(`[statements.monthly] monthly owner=${ownerId} failed`, err);
      tally.errors += 1;
    }
  }
  for (const ownerId of invoiceFor) {
    try {
      if ((await buildInvoice(ownerId, month))?.created) tally.invoices += 1;
    } catch (err) {
      console.error(`[statements.monthly] invoice owner=${ownerId} failed`, err);
      tally.errors += 1;
    }
  }
  return { ran: true, month, ...tally };
};

// ---------------------------------------------------------------- reads

type StatementRow = Prisma.OwnerStatementGetPayload<object>;

const totalsOf = (row: StatementRow) => (row.totals ?? {}) as Record<string, unknown>;

/** The headline amount: closing balance, amount paid, or invoice total. */
const amountOf = (row: StatementRow) => {
  const t = totalsOf(row);
  const value = row.kind === StatementKind.MONTHLY ? t.closingMinor : row.kind === StatementKind.PAYOUT ? t.netMinor : t.totalMinor;
  return typeof value === "number" ? value : 0;
};

const titleOf = (row: StatementRow) => {
  const t = totalsOf(row);
  if (row.kind === StatementKind.MONTHLY) return `Statement · ${monthLabel(monthOf(row.periodStart))}`;
  if (row.kind === StatementKind.INVOICE) return `Commission invoice ${row.number} · ${monthLabel(monthOf(row.periodStart))}`;
  return `Payout ${String(t.reference ?? row.payoutId)}`;
};

const listItem = (row: StatementRow) => ({
  id: row.id,
  kind: row.kind,
  number: row.number,
  title: titleOf(row),
  periodStart: row.periodStart,
  periodEnd: row.periodEnd,
  payoutId: row.payoutId,
  amountMinor: amountOf(row),
  createdAt: row.createdAt,
});

const listQuery = z.object({
  kind: z.nativeEnum(StatementKind).optional(),
  ownerId: z.string().uuid().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const parseList = (input: unknown) => {
  const parsed = listQuery.safeParse(input);
  if (!parsed.success) throw new ApiError(StatusCodes.BAD_REQUEST, parsed.error.issues[0]?.message ?? "Invalid query");
  return parsed.data;
};

const listStatements = async (where: Prisma.OwnerStatementWhereInput, q: { cursor?: string; limit: number }) => {
  const rows = await prisma.ownerStatement.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
    ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
  });
  const page = rows.slice(0, q.limit);
  return { rows: page, nextCursor: rows.length > q.limit ? page[page.length - 1].id : null };
};

const ownerOf = (req: Request) => assertOwnerOf(withAccessCache(req));

const ok = (res: Response, message: string, data: unknown) =>
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message, data });

const findOwned = async (req: Request) => {
  const { ownerId } = await ownerOf(req);
  const parsed = z.string().uuid().safeParse(req.params.id);
  const row = parsed.success
    ? await prisma.ownerStatement.findFirst({ where: { id: parsed.data, ownerId } })
    : null;
  if (!row) throw new ApiError(StatusCodes.NOT_FOUND, "Not found");
  return row;
};

/** GET /owner/statements?kind&cursor - newest first. */
const list = catchAsync(async (req: Request, res: Response) => {
  const { ownerId } = await ownerOf(req);
  const q = parseList(req.query);
  const { rows, nextCursor } = await listStatements({ ownerId, ...(q.kind && { kind: q.kind }) }, q);
  ok(res, "Statements", { items: rows.map(listItem), nextCursor });
});

/** GET /owner/statements/:id - everything the printable page needs. */
const detail = catchAsync(async (req: Request, res: Response) => {
  const row = await findOwned(req);
  const [owner, legalName, bin] = await Promise.all([
    prisma.salonOwner.findUniqueOrThrow({
      where: { id: row.ownerId },
      select: {
        businessName: true,
        legalName: true,
        businessAddress: true,
        businessPhone: true,
        businessEmail: true,
        bin: true,
        tin: true,
        user: { select: { name: true, email: true } },
      },
    }),
    getSetting("finance.legalName"),
    getSetting("finance.bin"),
  ]);
  const totals = totalsOf(row);
  // An invoice prints the seller it was issued under; the others the current one.
  const seller = (row.kind === StatementKind.INVOICE ? totals.seller : null) ?? { legalName, bin: bin || null };

  ok(res, "Statement", {
    ...listItem(row),
    totals,
    ledgerHash: row.ledgerHash,
    platform: seller,
    owner: {
      businessName: owner.businessName ?? owner.user.name,
      legalName: owner.legalName,
      address: owner.businessAddress,
      phone: owner.businessPhone,
      email: owner.businessEmail ?? owner.user.email,
      bin: owner.bin,
      tin: owner.tin,
    },
  });
});

type CsvLine = {
  date: Date;
  branch: string;
  type: string;
  description: string;
  amountMinor: number;
  bookingToken: string | null;
  payoutId: string | null;
};

/** The ledger lines behind a statement, oldest first. */
const csvLines = async (row: StatementRow): Promise<CsvLine[]> => {
  const select = {
    createdAt: true,
    amountMinor: true,
    description: true,
    salonId: true,
    payoutId: true,
    salon: { select: { name: true } },
    appointment: { select: { token: true } },
  } satisfies Prisma.LedgerEntrySelect;
  const toLine = (e: Prisma.LedgerEntryGetPayload<{ select: typeof select }>, sign = 1): CsvLine => ({
    date: e.createdAt,
    branch: e.salon?.name ?? "Deleted branch",
    type: typeOf(e.description),
    description: e.description,
    amountMinor: sign * e.amountMinor,
    bookingToken: e.appointment?.token ?? null,
    payoutId: e.payoutId,
  });
  const inPeriod = { gte: row.periodStart, lt: row.periodEnd };
  const base = { ownerId: row.ownerId, account: PAYABLE };

  if (row.kind === StatementKind.PAYOUT) {
    const entries = await prisma.ledgerEntry.findMany({
      where: { payoutId: row.payoutId, account: PAYABLE },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: CSV_MAX_ROWS,
      select,
    });
    return entries.map((e) => toLine(e));
  }

  if (row.kind === StatementKind.INVOICE) {
    const entries = await prisma.ledgerEntry.findMany({
      where: { ...base, description: { in: TYPE_DESCRIPTIONS.commission }, createdAt: inPeriod },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: CSV_MAX_ROWS,
      select,
    });
    // Commission is a charge on the invoice: positive.
    return entries.map((e) => toLine(e, -1));
  }

  // MONTHLY: every line of the month, then one line per payout paid in it, so
  // the amount column sums to closing − opening.
  const [entries, payouts] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: { ...base, createdAt: inPeriod },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: CSV_MAX_ROWS,
      select,
    }),
    prisma.ledgerEntry.groupBy({
      by: ["payoutId"],
      where: { ...base, payout: { status: PayoutStatus.PAID, paidAt: inPeriod } },
      _sum: { amountMinor: true },
    }),
  ]);
  const paid = await prisma.payout.findMany({
    where: { id: { in: payouts.map((p) => p.payoutId!) } },
    select: { id: true, paidAt: true, reference: true },
  });
  const sumOf = new Map(payouts.map((p) => [p.payoutId, p._sum.amountMinor ?? 0]));
  return [
    ...entries.map((e) => toLine(e)),
    ...paid.map((p) => ({
      date: p.paidAt!,
      branch: "",
      type: "payout",
      description: `Payout SK-PO-${p.id.slice(0, 8).toUpperCase()} paid${p.reference ? ` (ref ${p.reference})` : ""}`,
      amountMinor: -(sumOf.get(p.id) ?? 0),
      bookingToken: null,
      payoutId: p.id,
    })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());
};

/** GET /owner/statements/:id.csv - the ledger lines behind the statement. */
const csv = catchAsync(async (req: Request, res: Response) => {
  const row = await findOwned(req);
  const lines = await csvLines(row);
  const columns: CsvColumn<CsvLine>[] = [
    { header: "date", value: (l) => l.date },
    { header: "branch", value: (l) => l.branch },
    { header: "type", value: (l) => l.type },
    { header: "description", value: (l) => l.description },
    { header: "amount_taka", value: (l) => l.amountMinor, money: true },
    { header: "booking_token", value: (l) => l.bookingToken ?? "" },
    { header: "payout_id", value: (l) => l.payoutId ?? "" },
  ];
  const name = row.number ?? `${row.kind.toLowerCase()}-${dhakaDay(row.periodStart)}`;
  let offset = 0;
  await streamCsv(res, {
    filename: `statement-${name}.csv`,
    columns,
    // The owner's own lines; there is no customer PII in them.
    showPii: true,
    fetchBatch: async (_after, take) => {
      const batch = lines.slice(offset, offset + take);
      offset += batch.length;
      return batch;
    },
  });
});

/** Admin: GET /admin/finance/statements?ownerId&kind&cursor - read-only. */
export const adminListStatements = async (query: unknown) => {
  const q = parseList(query);
  const { rows, nextCursor } = await listStatements(
    { ...(q.ownerId && { ownerId: q.ownerId }), ...(q.kind && { kind: q.kind }) },
    q,
  );
  const owners = await prisma.salonOwner.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.ownerId))] } },
    select: { id: true, businessName: true, user: { select: { name: true } } },
  });
  const nameOf = new Map(owners.map((o) => [o.id, o.businessName ?? o.user.name]));
  return {
    items: rows.map((row) => ({
      ...listItem(row),
      ownerId: row.ownerId,
      ownerName: nameOf.get(row.ownerId) ?? null,
      totals: row.totals,
      ledgerHash: row.ledgerHash,
    })),
    nextCursor,
  };
};

export const OwnerStatements = { list, detail, csv };
