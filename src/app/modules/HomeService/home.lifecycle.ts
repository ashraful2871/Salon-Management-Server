import { createHmac, timingSafeEqual } from "crypto";
import { AdvanceStatus, BalanceMethod, HomeAudience, HomeBookingStatus, LedgerAccount, Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import config from "../../../config";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { AuditCtx, auditTx } from "../../utils/audit";
import { AccessUser, assertSalonPermission, scopeSalonIds } from "../../utils/salonAccess";
import { addDays, dhakaDay, isDay } from "../Analytics/analytics.days";
import { writeJournal } from "../Settlement/settlement.service";
import { lockStaff } from "../Staff/staff.schedule";
import { WalletService } from "../Wallet/wallet.service";
import { expertCanTake } from "./home.availability";
import { Actor, expireStaleOf, getBooking, isContention, isExclusionViolation } from "./home.booking";
import { ACTIVE_BOOKING_STATUSES } from "./home.expertSetup";
import { homeCommissionMinor } from "./home.money";
import { homeNotice, notifyHomeBooking } from "./home.notify";
import type { CompleteJobBody, OwnerBookingsQuery } from "./home.validation";

/**
 * The visit itself: the expert's My jobs and the CONFIRMED → EN_ROUTE →
 * ARRIVED → IN_PROGRESS → COMPLETED moves, the customer paying the balance
 * from the wallet, the owner board (reassign, start without the code) and the
 * settlement on COMPLETED that hands the held money to the booked salon.
 * Every move is a conditional update on the from-status plus an event row.
 */

type Tx = Prisma.TransactionClient;

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
/** The address and phone open to the expert this long before the start. */
const ADDRESS_REVEAL_MS = 2 * HOUR_MS;
/** The expert can set off this long before the start. */
const EN_ROUTE_FROM_MS = 3 * HOUR_MS;
const MAX_START_TRIES = 5;
/** My jobs: today and the next 7 days. */
const JOB_DAYS = 8;
const PAGE_SIZE = 20;
/** A visit still IN_PROGRESS this long after its end is closed by `home.stale`. */
const STALE_AFTER_MS = 3 * HOUR_MS;
/** An expert not arrived this long after the start is flagged by `home.notArrived`. */
const LATE_AFTER_MS = 45 * MIN_MS;

export const STALE_CLOSED_FLAG = "STALE_CLOSED";
export const EXPERT_LATE_FLAG = "EXPERT_LATE_FLAG";

/** Statuses in which the customer still needs the start code. */
const CODE_STATUSES: HomeBookingStatus[] = [HomeBookingStatus.CONFIRMED, HomeBookingStatus.EN_ROUTE, HomeBookingStatus.ARRIVED];
/** Statuses in which the balance can still be paid from the wallet. */
const PAY_BALANCE_STATUSES: HomeBookingStatus[] = [
  HomeBookingStatus.CONFIRMED,
  HomeBookingStatus.EN_ROUTE,
  HomeBookingStatus.ARRIVED,
  HomeBookingStatus.IN_PROGRESS,
];
/** Never shown to an expert or on the board: nobody paid for them. */
const UNPAID: HomeBookingStatus[] = [HomeBookingStatus.PENDING_PAYMENT, HomeBookingStatus.EXPIRED];

const fail = (status: number, message: string, code: string, details?: Record<string, unknown>) =>
  ApiError.withCode(status, message, code, details);
const notFound = () => new ApiError(StatusCodes.NOT_FOUND, "Job not found");
const invalidState = (message = "This visit changed. Refresh and try again.") =>
  fail(StatusCodes.CONFLICT, message, "INVALID_STATE");

// ---------------------------------------------------------------------------
// Start code
// ---------------------------------------------------------------------------

/** The 4-digit code the customer reads out at the door. Never stored. */
export const hmacCode = (bookingId: string) => {
  const secret = config.homeService.startCodeSecret;
  if (!secret) throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, "HOME_START_CODE_SECRET is not set");
  const hex = createHmac("sha256", secret).update(bookingId).digest("hex");
  return String(parseInt(hex.slice(0, 8), 16) % 10_000).padStart(4, "0");
};

/** The customer's view of the code: only while the expert has not started. */
export const startCodeFor = (b: { id: string; status: HomeBookingStatus }) =>
  CODE_STATUSES.includes(b.status) ? hmacCode(b.id) : null;

const sameCode = (given: string, expected: string) =>
  given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

type Move = {
  from: HomeBookingStatus;
  to: HomeBookingStatus;
  actorId: string | null;
  actorRole: string;
  reason?: string | null;
  data?: Prisma.HomeBookingUpdateManyMutationInput;
  where?: Prisma.HomeBookingWhereInput;
};

/** The one way a visit changes status: conditional on `from`, with its event. */
export const moveTx = async (tx: Tx, id: string, m: Move) => {
  const n = await tx.homeBooking.updateMany({
    where: { ...m.where, id, status: m.from },
    data: { ...m.data, status: m.to },
  });
  if (!n.count) throw invalidState();
  await tx.homeBookingEvent.create({
    data: { bookingId: id, fromStatus: m.from, toStatus: m.to, actorId: m.actorId, actorRole: m.actorRole, reason: m.reason ?? null },
  });
};

// ---------------------------------------------------------------------------
// Settlement on COMPLETED
// ---------------------------------------------------------------------------

/**
 * Runs in the transaction that moved the visit to COMPLETED. Everything the
 * platform held for it (the advance, and the balance when it was paid from
 * the wallet) leaves the customer's wallet and becomes the booked salon's
 * SALON_PAYABLE: pending until `payouts.holdDays`, then in the weekly payout
 * like a completed appointment (the buckets key on ownerId / salonId only).
 * Commission is the snapshot rate on the subtotal, whatever was collected at
 * the door, so a cash visit can leave the business owing (dues). Idempotent
 * through `advanceStatus`.
 */
export const settleHomeCompletedTx = async (tx: Tx, bookingId: string) => {
  const b = await tx.homeBooking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      code: true,
      status: true,
      customerId: true,
      salonId: true,
      expertId: true,
      advanceMinor: true,
      advanceStatus: true,
      balanceMinor: true,
      balanceMethod: true,
      subtotalMinor: true,
      commissionBps: true,
      salon: { select: { ownerId: true } },
    },
  });
  if (!b || b.status !== HomeBookingStatus.COMPLETED || b.advanceStatus === AdvanceStatus.APPLIED) return null;

  const label = `Home visit ${b.code}`;
  const appliedMinor =
    b.advanceStatus === AdvanceStatus.HELD
      ? b.advanceMinor + (b.balanceMethod === BalanceMethod.WALLET ? b.balanceMinor : 0)
      : 0;
  if (appliedMinor > 0) {
    await WalletService.applyHomeHeld(b.customerId, appliedMinor, b.id, label, tx);
  }

  const commissionMinor = homeCommissionMinor(b.subtotalMinor, b.commissionBps);
  await writeJournal(tx, {
    homeBookingId: b.id,
    salonId: b.salonId,
    ownerId: b.salon.ownerId,
    kind: "home.completed",
    drafts: [
      { account: LedgerAccount.CUSTOMER_WALLET, amountMinor: -appliedMinor, description: label },
      { account: LedgerAccount.SALON_PAYABLE, amountMinor: appliedMinor, description: label },
      // 0 at launch: writeJournal drops zero lines.
      { account: LedgerAccount.SALON_PAYABLE, amountMinor: -commissionMinor, description: `Platform commission - ${label}` },
      { account: LedgerAccount.PLATFORM_REVENUE, amountMinor: commissionMinor, description: `Platform commission - ${label}` },
    ],
  });

  await tx.homeBooking.update({ where: { id: b.id }, data: { advanceStatus: AdvanceStatus.APPLIED } });
  await tx.homeExpert.update({ where: { id: b.expertId }, data: { completedJobs: { increment: 1 } } });
  return { appliedMinor, commissionMinor };
};

// ---------------------------------------------------------------------------
// Expert: My jobs
// ---------------------------------------------------------------------------

const JOB = {
  id: true,
  code: true,
  status: true,
  audience: true,
  startAt: true,
  endAt: true,
  area: true,
  addressLine: true,
  landmark: true,
  latitude: true,
  longitude: true,
  contactPhone: true,
  recipientName: true,
  notes: true,
  balanceMinor: true,
  balanceMethod: true,
  startCodeTries: true,
  salon: { select: { id: true, name: true } },
  items: { select: { nameSnapshot: true, durationMin: true } },
} satisfies Prisma.HomeBookingSelect;

type JobRow = Prisma.HomeBookingGetPayload<{ select: typeof JOB }>;

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

/** The address and phone: from 2 h before the start, or once the expert set off. */
const addressOpen = (b: { status: HomeBookingStatus; startAt: Date }, now: Date) =>
  ACTIVE_BOOKING_STATUSES.includes(b.status) &&
  (b.status !== HomeBookingStatus.CONFIRMED || now.getTime() >= b.startAt.getTime() - ADDRESS_REVEAL_MS);

const jobView = (b: JobRow, now = new Date()) => {
  const open = addressOpen(b, now);
  const paidInApp = b.balanceMethod === BalanceMethod.WALLET;
  return {
    id: b.id,
    code: b.code,
    status: b.status,
    audience: b.audience,
    startAt: b.startAt,
    endAt: b.endAt,
    area: b.area,
    salon: b.salon,
    services: b.items.map((i) => ({ name: i.nameSnapshot, durationMin: i.durationMin })),
    recipientFirstName: firstName(b.recipientName),
    /** What to collect at the door: 0 once the customer paid it in the app. */
    balanceMinor: paidInApp ? 0 : b.balanceMinor,
    balancePaidInApp: paidInApp,
    startCodeTriesLeft: Math.max(0, MAX_START_TRIES - b.startCodeTries),
    canSetOffFrom: new Date(b.startAt.getTime() - EN_ROUTE_FROM_MS),
    addressRevealAt: new Date(b.startAt.getTime() - ADDRESS_REVEAL_MS),
    address: open
      ? { addressLine: b.addressLine, landmark: b.landmark, latitude: b.latitude, longitude: b.longitude, notes: b.notes }
      : null,
    contactPhone: open ? b.contactPhone : null,
  };
};

/** The caller's own job (the expert's staff user), else 404. */
const myJobWhere = (userId: string, id: string): Prisma.HomeBookingWhereInput => ({
  id,
  status: { notIn: UNPAID },
  expert: { staff: { userId } },
});

export const listMyJobs = async (userId: string, date?: string) => {
  const today = dhakaDay();
  const last = addDays(today, JOB_DAYS - 1);
  if (date !== undefined && (!isDay(date) || date < today || date > last)) {
    throw new ApiError(StatusCodes.BAD_REQUEST, `Pick a day from ${today} to ${last}.`);
  }
  const from = date ?? today;
  const to = date ?? last;
  const rows = await prisma.homeBooking.findMany({
    where: {
      status: { notIn: UNPAID },
      expert: { staff: { userId } },
      serviceDate: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
    },
    select: JOB,
    orderBy: [{ startAt: "asc" }, { id: "asc" }],
  });
  const now = new Date();
  return { from, to, jobs: rows.map((r) => jobView(r, now)) };
};

export const getMyJob = async (userId: string, id: string) => {
  const b = await prisma.homeBooking.findFirst({ where: myJobWhere(userId, id), select: JOB });
  if (!b) throw notFound();
  return jobView(b);
};

const loadMyJob = async (userId: string, id: string) => {
  const b = await prisma.homeBooking.findFirst({
    where: myJobWhere(userId, id),
    select: { id: true, status: true, startAt: true, startCodeTries: true, balanceMinor: true, balanceMethod: true },
  });
  if (!b) throw notFound();
  return b;
};

export const setOff = async (userId: string, id: string) => {
  const b = await loadMyJob(userId, id);
  if (b.status !== HomeBookingStatus.CONFIRMED) throw invalidState();
  if (Date.now() < b.startAt.getTime() - EN_ROUTE_FROM_MS) {
    throw invalidState("You can set off from 3 hours before the visit.");
  }
  await prisma.$transaction((tx) =>
    moveTx(tx, id, {
      from: HomeBookingStatus.CONFIRMED,
      to: HomeBookingStatus.EN_ROUTE,
      actorId: userId,
      actorRole: "EXPERT",
      data: { enRouteAt: new Date() },
    }),
  );
  homeNotice(id, { kind: "en_route" });
  return getMyJob(userId, id);
};

export const arrived = async (userId: string, id: string) => {
  await loadMyJob(userId, id);
  await prisma.$transaction((tx) =>
    moveTx(tx, id, {
      from: HomeBookingStatus.EN_ROUTE,
      to: HomeBookingStatus.ARRIVED,
      actorId: userId,
      actorRole: "EXPERT",
      data: { arrivedAt: new Date() },
    }),
  );
  homeNotice(id, { kind: "arrived" });
  return getMyJob(userId, id);
};

const locked = () =>
  fail(
    StatusCodes.LOCKED,
    "Too many wrong codes. Ask the salon to start the visit for you.",
    "START_CODE_LOCKED",
  );

export const startJob = async (userId: string, id: string, code: string) => {
  const b = await loadMyJob(userId, id);
  if (b.status !== HomeBookingStatus.ARRIVED) throw invalidState();
  if (b.startCodeTries >= MAX_START_TRIES) throw locked();

  if (!sameCode(code, hmacCode(id))) {
    // Counted atomically, so parallel guesses can't get past the limit.
    const rows = await prisma.$queryRaw<{ startCodeTries: number }[]>`
      UPDATE home_bookings SET "startCodeTries" = "startCodeTries" + 1, "updatedAt" = now()
      WHERE id = ${id} AND status = 'ARRIVED' AND "startCodeTries" < ${MAX_START_TRIES}
      RETURNING "startCodeTries"`;
    const tries = rows[0]?.startCodeTries ?? MAX_START_TRIES;
    if (tries >= MAX_START_TRIES) throw locked();
    throw fail(StatusCodes.BAD_REQUEST, "That code isn't right. Ask the customer to read it again.", "START_CODE_INVALID", {
      triesLeft: MAX_START_TRIES - tries,
    });
  }

  await prisma.$transaction((tx) =>
    moveTx(tx, id, {
      from: HomeBookingStatus.ARRIVED,
      to: HomeBookingStatus.IN_PROGRESS,
      actorId: userId,
      actorRole: "EXPERT",
      data: { startedAt: new Date() },
      where: { startCodeTries: { lt: MAX_START_TRIES } },
    }),
  );
  return getMyJob(userId, id);
};

/**
 * IN_PROGRESS → COMPLETED and the settlement, in one transaction. A balance
 * the customer already paid in the app is recorded as WALLET whatever the
 * expert picked; WALLET is refused when they didn't.
 */
export const completeJob = async (userId: string, id: string, body: CompleteJobBody) => {
  const b = await loadMyJob(userId, id);
  if (b.status !== HomeBookingStatus.IN_PROGRESS) throw invalidState();
  const paidInApp = b.balanceMethod === BalanceMethod.WALLET;
  if (body.balanceMethod === BalanceMethod.WALLET && !paidInApp) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "The customer hasn't paid the balance in the app. Pick how you collected it.");
  }
  const note = body.note?.trim() || null;
  if (body.balanceMethod === BalanceMethod.NOT_COLLECTED && !note && !paidInApp) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Add a note saying why the balance wasn't collected.");
  }

  await prisma.$transaction(
    async (tx) => {
      await moveTx(tx, id, {
        from: HomeBookingStatus.IN_PROGRESS,
        to: HomeBookingStatus.COMPLETED,
        actorId: userId,
        actorRole: "EXPERT",
        reason: note,
        data: {
          completedAt: new Date(),
          balanceMethod: paidInApp ? BalanceMethod.WALLET : body.balanceMethod,
          balanceCollectedMinor: paidInApp ? b.balanceMinor : body.collectedMinor,
        },
      });
      await settleHomeCompletedTx(tx, id);
    },
    { maxWait: 10_000, timeout: 20_000 },
  );
  homeNotice(id, { kind: "completed" });
  return getMyJob(userId, id);
};

// ---------------------------------------------------------------------------
// Customer: pay the balance from the wallet
// ---------------------------------------------------------------------------

export const payBalance = async (actor: Actor, id: string) => {
  if (actor.impersonating) {
    throw fail(StatusCodes.FORBIDDEN, "Read-only view: changes are not allowed while viewing as this user.", "IMPERSONATION_READ_ONLY");
  }
  const b = await prisma.homeBooking.findFirst({
    where: { id, customerId: actor.userId },
    select: { id: true, status: true, balanceMinor: true, balanceMethod: true },
  });
  if (!b) throw new ApiError(StatusCodes.NOT_FOUND, "Booking not found");
  if (b.balanceMethod === BalanceMethod.WALLET) return getBooking(actor.userId, id);
  if (!PAY_BALANCE_STATUSES.includes(b.status)) throw fail(StatusCodes.CONFLICT, "The balance can't be paid now.", "INVALID_STATE");
  if (b.balanceMinor <= 0) throw fail(StatusCodes.CONFLICT, "There is no balance left to pay.", "INVALID_STATE");

  const wallet = await WalletService.getOrCreateWallet(actor.userId);
  if (wallet.isFrozen) throw fail(StatusCodes.FORBIDDEN, "Your wallet is frozen. Contact support.", "WALLET_FROZEN");
  const available = WalletService.availableOf(wallet);
  if (available < b.balanceMinor) {
    const short = new ApiError(StatusCodes.BAD_REQUEST, "Your wallet doesn't cover the balance. Top up first, or pay the expert at the door.");
    short.details = { shortfallMinor: b.balanceMinor - Math.max(available, 0) };
    throw short;
  }

  await prisma.$transaction(async (tx) => {
    const n = await tx.homeBooking.updateMany({
      where: { id, status: { in: PAY_BALANCE_STATUSES }, balanceMethod: null },
      data: { balanceMethod: BalanceMethod.WALLET },
    });
    if (!n.count) throw invalidState();
    await WalletService.holdHomeBalance(actor.userId, b.balanceMinor, id, tx);
  });
  return getBooking(actor.userId, id);
};

// ---------------------------------------------------------------------------
// Owner board (homeservice.bookings)
// ---------------------------------------------------------------------------

const BOARD = {
  ...JOB,
  customerId: true,
  totalMinor: true,
  advanceMinor: true,
  advanceStatus: true,
  balanceCollectedMinor: true,
  subtotalMinor: true,
  travelFeeMinor: true,
  createdAt: true,
  expert: { select: { id: true, audience: true, staff: { select: { user: { select: { name: true } } } } } },
  customer: { select: { name: true } },
} satisfies Prisma.HomeBookingSelect;

type BoardRow = Prisma.HomeBookingGetPayload<{ select: typeof BOARD }>;

/** The board sees the address at any time. */
const boardView = (b: BoardRow) => ({
  id: b.id,
  code: b.code,
  status: b.status,
  audience: b.audience,
  startAt: b.startAt,
  endAt: b.endAt,
  salon: b.salon,
  expert: { id: b.expert.id, name: b.expert.staff.user.name, audience: b.expert.audience },
  customerName: b.customer.name,
  recipientName: b.recipientName,
  contactPhone: b.contactPhone,
  address: { addressLine: b.addressLine, area: b.area, landmark: b.landmark, latitude: b.latitude, longitude: b.longitude },
  notes: b.notes,
  services: b.items.map((i) => ({ name: i.nameSnapshot, durationMin: i.durationMin })),
  subtotalMinor: b.subtotalMinor,
  travelFeeMinor: b.travelFeeMinor,
  totalMinor: b.totalMinor,
  advanceMinor: b.advanceMinor,
  advanceStatus: b.advanceStatus,
  balanceMinor: b.balanceMinor,
  balanceMethod: b.balanceMethod,
  balanceCollectedMinor: b.balanceCollectedMinor,
  startCodeTries: b.startCodeTries,
  createdAt: b.createdAt,
});

export type BoardQuery = OwnerBookingsQuery;

export const listOwnerBookings = async (user: AccessUser, q: BoardQuery) => {
  const page = q.page ?? 1;
  const salonIds = await scopeSalonIds(user, "homeservice.bookings", q.salonId);
  if (salonIds && salonIds.length === 0) return { meta: { page, limit: PAGE_SIZE, total: 0 }, data: [] };

  const where: Prisma.HomeBookingWhereInput = {
    ...(salonIds ? { salonId: { in: salonIds } } : {}),
    status: q.status ? q.status : { notIn: UNPAID },
    ...(q.audience ? { audience: q.audience } : {}),
    ...(q.expertId ? { expertId: q.expertId } : {}),
    ...(q.from || q.to
      ? {
          serviceDate: {
            ...(q.from ? { gte: new Date(`${q.from}T00:00:00Z`) } : {}),
            ...(q.to ? { lte: new Date(`${q.to}T00:00:00Z`) } : {}),
          },
        }
      : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.homeBooking.count({ where }),
    prisma.homeBooking.findMany({
      where,
      select: BOARD,
      orderBy: [{ startAt: "asc" }, { id: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);
  return { meta: { page, limit: PAGE_SIZE, total }, data: rows.map(boardView) };
};

const loadBoardBooking = async (user: AccessUser, id: string) => {
  const b = await prisma.homeBooking.findUnique({
    where: { id },
    select: {
      id: true,
      salonId: true,
      status: true,
      audience: true,
      expertId: true,
      startAt: true,
      blockFrom: true,
      blockTo: true,
      createdAt: true,
      items: { select: { offeringId: true } },
    },
  });
  if (!b || UNPAID.includes(b.status)) throw notFound();
  await assertSalonPermission(user, b.salonId, "homeservice.bookings");
  return b;
};

export const getBoardBooking = async (id: string) => {
  const b = await prisma.homeBooking.findUnique({ where: { id }, select: BOARD });
  if (!b) throw notFound();
  return boardView(b);
};

const slotTaken = () => fail(StatusCodes.CONFLICT, "This expert isn't free at that time.", "SLOT_TAKEN");

/**
 * Under the new expert's stylist lock, in the caller's transaction: a
 * CONFIRMED visit moves to `target` when they are free and do every item
 * (judged as of the original booking — lead time, window — with today's busy
 * times), else SLOT_TAKEN. The overlap exclusion backs it up. Reassign and an
 * expert leaving (home.cancel) both use it.
 */
export const moveToExpertTx = async (
  tx: Tx,
  b: { id: string; expertId: string; startAt: Date; blockFrom: Date; blockTo: Date; createdAt: Date; offeringIds: string[] },
  target: { id: string; staffId: string; audience: HomeAudience },
  event: { actorId: string | null; actorRole: string; reason: string },
) => {
  await lockStaff(tx, target.staffId);
  await expireStaleOf(tx, target.id);
  const clash = await tx.homeBooking.findFirst({
    where: { expertId: target.id, status: { in: ACTIVE_BOOKING_STATUSES }, blockFrom: { lt: b.blockTo }, blockTo: { gt: b.blockFrom } },
    select: { id: true },
  });
  if (clash) throw slotTaken();
  const { ok } = await expertCanTake({
    expertId: target.id,
    offeringIds: b.offeringIds,
    startAt: b.startAt,
    now: b.createdAt,
    excludeBookingId: b.id,
    db: tx,
  });
  if (!ok) throw slotTaken();

  const n = await tx.homeBooking.updateMany({
    where: { id: b.id, status: HomeBookingStatus.CONFIRMED, expertId: b.expertId },
    data: { expertId: target.id, expertAudience: target.audience, startCodeTries: 0 },
  });
  if (!n.count) throw invalidState();
  await tx.homeBookingEvent.create({
    data: {
      bookingId: b.id,
      fromStatus: HomeBookingStatus.CONFIRMED,
      toStatus: HomeBookingStatus.CONFIRMED,
      actorId: event.actorId,
      actorRole: event.actorRole,
      reason: event.reason,
    },
  });
};

/**
 * Another expert of the same branch and side takes a CONFIRMED visit. Under
 * the new expert's stylist lock, with the same checks as a booking (verified,
 * does every item, free at that time); the overlap exclusion backs it up.
 * Not a salon cancel: `cancelledBySalon` stays as it is.
 */
export const reassign = async (user: AccessUser, ctx: AuditCtx, id: string, expertId: string, reason: string) => {
  const b = await loadBoardBooking(user, id);
  if (b.status !== HomeBookingStatus.CONFIRMED) throw invalidState("Only a confirmed visit that hasn't started can be reassigned.");
  if (b.expertId === expertId) throw new ApiError(StatusCodes.BAD_REQUEST, "This expert already has the visit.");

  const target = await prisma.homeExpert.findUnique({
    where: { id: expertId },
    select: { id: true, salonId: true, audience: true, staffId: true, staff: { select: { user: { select: { name: true } } } } },
  });
  if (!target || target.salonId !== b.salonId) {
    throw fail(StatusCodes.NOT_FOUND, "This expert isn't available.", "EXPERT_UNAVAILABLE");
  }
  if (target.audience !== b.audience) {
    throw fail(
      StatusCodes.BAD_REQUEST,
      b.audience === HomeAudience.LADIES ? "A Ladies visit needs a female expert." : "A Gents visit needs a male expert.",
      "EXPERT_GENDER_MISMATCH",
    );
  }

  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '8s'`;
        await moveToExpertTx(tx, { ...b, offeringIds: b.items.map((i) => i.offeringId) }, target, {
          actorId: ctx.actorUserId,
          actorRole: user.role,
          reason: `Reassigned to ${target.staff.user.name}: ${reason}`,
        });
        await auditTx(tx, ctx, {
          action: "homeService.booking_reassign",
          entityType: "HomeBooking",
          entityId: id,
          salonId: b.salonId,
          before: { expertId: b.expertId },
          after: { expertId: target.id },
          reason,
        });
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
  } catch (e) {
    if (isExclusionViolation(e) || isContention(e)) throw slotTaken();
    throw e;
  }
  homeNotice(id, { kind: "reassigned", fromExpertId: b.expertId });
  return getBoardBooking(id);
};

/** ARRIVED → IN_PROGRESS without the code (the customer can't find it, or it locked). */
export const overrideStart = async (user: AccessUser, ctx: AuditCtx, id: string, reason: string) => {
  const b = await loadBoardBooking(user, id);
  if (b.status !== HomeBookingStatus.ARRIVED) throw invalidState("The expert has to arrive before the visit can start.");
  await prisma.$transaction(async (tx) => {
    await moveTx(tx, id, {
      from: HomeBookingStatus.ARRIVED,
      to: HomeBookingStatus.IN_PROGRESS,
      actorId: ctx.actorUserId,
      actorRole: user.role,
      reason: `Started without the code: ${reason}`,
      data: { startedAt: new Date() },
    });
    await auditTx(tx, ctx, {
      action: "homeService.booking_override_start",
      entityType: "HomeBooking",
      entityId: id,
      salonId: b.salonId,
      before: { status: HomeBookingStatus.ARRIVED },
      after: { status: HomeBookingStatus.IN_PROGRESS },
      reason,
    });
  });
  return getBoardBooking(id);
};

// ---------------------------------------------------------------------------
// Timer jobs (home.jobs.ts registers them)
// ---------------------------------------------------------------------------

/**
 * `home.stale`: a visit left IN_PROGRESS 3 h past its end is closed as
 * COMPLETED and settled like any other, with the balance NOT_COLLECTED (or
 * WALLET when it was paid in the app, so that hold isn't stranded) and the
 * event flagged STALE_CLOSED for the board and the admin.
 */
export const closeStaleVisits = async () => {
  const rows = await prisma.homeBooking.findMany({
    where: { status: HomeBookingStatus.IN_PROGRESS, endAt: { lt: new Date(Date.now() - STALE_AFTER_MS) } },
    select: { id: true, balanceMinor: true, balanceMethod: true },
    take: 100,
  });
  let closed = 0;
  for (const b of rows) {
    const paidInApp = b.balanceMethod === BalanceMethod.WALLET;
    try {
      await prisma.$transaction(
        async (tx) => {
          await moveTx(tx, b.id, {
            from: HomeBookingStatus.IN_PROGRESS,
            to: HomeBookingStatus.COMPLETED,
            actorId: null,
            actorRole: "SYSTEM",
            reason: `${STALE_CLOSED_FLAG}: closed by system`,
            data: {
              completedAt: new Date(),
              balanceMethod: paidInApp ? BalanceMethod.WALLET : BalanceMethod.NOT_COLLECTED,
              balanceCollectedMinor: paidInApp ? b.balanceMinor : 0,
            },
          });
          await settleHomeCompletedTx(tx, b.id);
        },
        { maxWait: 10_000, timeout: 20_000 },
      );
      closed++;
      await notifyHomeBooking(b.id, { kind: "completed" });
    } catch (e) {
      // Completed by the expert in the meantime, or one bad row: the next run retries.
      if (!(e instanceof ApiError)) console.error(`[jobs] home.stale: ${b.id}`, e);
    }
  }
  return { closed };
};

/**
 * `home.notArrived`: an expert not there 45 min after the start gets one
 * EXPERT_LATE_FLAG event. Nothing else changes; the owner or an admin marks
 * the no-show (`expert-no-show`, home.cancel).
 */
export const flagLateExperts = async () => {
  const rows = await prisma.homeBooking.findMany({
    where: {
      status: { in: [HomeBookingStatus.CONFIRMED, HomeBookingStatus.EN_ROUTE] },
      startAt: { lt: new Date(Date.now() - LATE_AFTER_MS) },
      events: { none: { reason: EXPERT_LATE_FLAG } },
    },
    select: { id: true, status: true },
    take: 200,
  });
  if (rows.length) {
    await prisma.homeBookingEvent.createMany({
      data: rows.map((r) => ({ bookingId: r.id, fromStatus: r.status, toStatus: r.status, actorRole: "SYSTEM", reason: EXPERT_LATE_FLAG })),
    });
  }
  return { flagged: rows.length };
};
