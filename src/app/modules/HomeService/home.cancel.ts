import {
  AdvanceStatus,
  AppealStatus,
  BalanceMethod,
  BookingPause,
  CancelledBy,
  HomeBookingStatus,
  HomeNoShowParty,
  HomeSafetyKind,
  LedgerAccount,
  Prisma,
  SalonStatus,
  WalletTxType,
} from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { AuditCtx, auditTx } from "../../utils/audit";
import { formatBDT } from "../../utils/money";
import { AccessUser, assertSalonPermission } from "../../utils/salonAccess";
import { getSetting } from "../../utils/settings";
import { dhakaDay } from "../Analytics/analytics.days";
import { writeJournal } from "../Settlement/settlement.service";
import { lockStaff } from "../Staff/staff.schedule";
import { WalletService } from "../Wallet/wallet.service";
import { eligibleExperts, expertCanTake } from "./home.availability";
import { Actor, expireStaleOf, getBooking, isContention, isExclusionViolation } from "./home.booking";
import { getBoardBooking, moveToExpertTx, moveTx } from "./home.lifecycle";
import { isBranchBookable, loadHomeFlags } from "./home.owner";
import type { HomePolicy } from "./home.policy";
import type { RescheduleBody } from "./home.validation";

/**
 * Every way a home visit ends early, and the money each one returns. One pure
 * decision (`decideOutcome`, from the booking's own `policySnapshot`, never
 * the settings in force) and one settlement (`settleHomeEndTx`) run in the
 * transaction that moves the status, so the refund reaches the wallet at the
 * same moment the visit ends. Also: reschedule, appeals, the no-show block and
 * the branch / expert level ends (turn-off CANCEL, suspend, remove).
 */

type Tx = Prisma.TransactionClient;

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
/** An expert not there this long after the start can be marked a no-show. */
const EXPERT_NO_SHOW_AFTER_MS = 45 * MIN_MS;

const fail = (status: number, message: string, code: string, details?: Record<string, unknown>) =>
  ApiError.withCode(status, message, code, details);
const notFound = () => new ApiError(StatusCodes.NOT_FOUND, "Booking not found");
const invalidState = (message = "This visit changed. Refresh and try again.") =>
  fail(StatusCodes.CONFLICT, message, "INVALID_STATE");
const readOnly = () =>
  fail(StatusCodes.FORBIDDEN, "Read-only view: changes are not allowed while viewing as this user.", "IMPERSONATION_READ_ONLY");

/** The customer can cancel until the expert starts. */
const CUSTOMER_CANCELLABLE: HomeBookingStatus[] = [HomeBookingStatus.CONFIRMED, HomeBookingStatus.EN_ROUTE, HomeBookingStatus.ARRIVED];
/** Not yet on the way: what a branch / expert level end cancels. Visits already under way go ahead. */
const UPCOMING: HomeBookingStatus[] = [HomeBookingStatus.PENDING_PAYMENT, HomeBookingStatus.CONFIRMED];
const UNDER_WAY: HomeBookingStatus[] = [HomeBookingStatus.EN_ROUTE, HomeBookingStatus.ARRIVED, HomeBookingStatus.IN_PROGRESS];
const ADMIN_CANCELLABLE: HomeBookingStatus[] = [...UPCOMING, ...UNDER_WAY];
const EXPERT_LATE_STATUSES: HomeBookingStatus[] = [HomeBookingStatus.CONFIRMED, HomeBookingStatus.EN_ROUTE];

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type EndEvent =
  | { kind: "CUSTOMER_CANCEL"; now: Date }
  | { kind: "CUSTOMER_NO_SHOW" }
  | { kind: "MISMATCH_ABORT" }
  | { kind: "SALON_CANCEL" }
  | { kind: "EXPERT_NO_SHOW" }
  | { kind: "ADMIN_CANCEL"; salonAtFault: boolean }
  | { kind: "SYSTEM_CANCEL" }
  | { kind: "SAFETY_ABORT" };

export type Outcome = {
  /** The part of the advance kept. */
  feeMinor: number;
  feePercent: number;
  /** The part of the advance back to the customer's available balance. */
  refundMinor: number;
  salonShareMinor: number;
  platformShareMinor: number;
  /** Paid by the salon to the customer on top of the refund (salon at fault). */
  salonCreditMinor: number;
  reasonCode: string;
};

export type DecisionInput = {
  status: HomeBookingStatus;
  startAt: Date;
  advanceMinor: number;
  confirmedAt: Date | null;
  policySnapshot: unknown;
};

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const clampPct = (v: number) => Math.min(100, Math.max(0, v));

/** The booking's snapshot, with launch defaults for anything missing (fees 0, i.e. in the customer's favour). */
export const snapshotOf = (raw: unknown): HomePolicy => {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    policy: s.policy === "WINDOW" || s.policy === "NON_REFUNDABLE" ? s.policy : "FREE",
    version: num(s.version, 0),
    freeCancelHours: num(s.freeCancelHours, 3),
    lateCancelPercent: clampPct(num(s.lateCancelPercent, 0)),
    noShowPercent: clampPct(num(s.noShowPercent, 0)),
    nonRefundableGraceMinutes: Math.max(0, num(s.nonRefundableGraceMinutes, 0)),
    salonCancelCreditMinor: Math.max(0, Math.round(num(s.salonCancelCreditMinor, 0))),
    feeSalonSharePercent: clampPct(num(s.feeSalonSharePercent, 100)),
    appealWindowHours: Math.max(0, num(s.appealWindowHours, 48)),
    maxRescheduleCount: Math.max(0, num(s.maxRescheduleCount, 1)),
  };
};

const roundToTaka = (minor: number) => Math.round(minor / 100) * 100;

/** The salon's part of a kept fee; the platform gets the rest. */
export const splitFee = (feeMinor: number, feeSalonSharePercent: number) => {
  const salonShareMinor = Math.round((feeMinor * clampPct(feeSalonSharePercent)) / 100);
  return { salonShareMinor, platformShareMinor: feeMinor - salonShareMinor };
};

/** Customer cancel: the kept percent and why, from the booking's policy. */
const customerCancelPct = (b: DecisionInput, p: HomePolicy, now: Date): [number, string] => {
  const freeWindowLeft = b.startAt.getTime() - now.getTime() >= p.freeCancelHours * HOUR_MS;
  if (p.policy === "FREE") return [0, "FREE_CANCEL"];
  if (p.policy === "WINDOW") {
    return freeWindowLeft && b.status === HomeBookingStatus.CONFIRMED ? [0, "WINDOW_FREE"] : [p.lateCancelPercent, "WINDOW_LATE"];
  }
  const inGrace =
    p.nonRefundableGraceMinutes > 0 &&
    !!b.confirmedAt &&
    now.getTime() - b.confirmedAt.getTime() <= p.nonRefundableGraceMinutes * MIN_MS &&
    freeWindowLeft;
  return inGrace ? [0, "NON_REFUNDABLE_GRACE"] : [100, "NON_REFUNDABLE"];
};

/**
 * Pure: what an end returns. Customer cancel / no-show / mismatch follow the
 * snapshot's policy; every other end is a fixed 100% back, plus the salon's
 * credit when the salon is at fault. Nothing was paid on an unpaid booking.
 */
export const decideOutcome = (b: DecisionInput, event: EndEvent): Outcome => {
  const p = snapshotOf(b.policySnapshot);
  const paid = b.status === HomeBookingStatus.PENDING_PAYMENT || b.status === HomeBookingStatus.EXPIRED ? 0 : b.advanceMinor;

  let pct = 0;
  let credit = 0;
  let reasonCode: string;
  switch (event.kind) {
    case "CUSTOMER_CANCEL":
      [pct, reasonCode] = customerCancelPct(b, p, event.now);
      break;
    case "CUSTOMER_NO_SHOW":
    case "MISMATCH_ABORT":
      pct = p.policy === "NON_REFUNDABLE" ? 100 : p.noShowPercent;
      reasonCode = event.kind;
      break;
    case "SALON_CANCEL":
    case "EXPERT_NO_SHOW":
      credit = p.salonCancelCreditMinor;
      reasonCode = event.kind;
      break;
    case "ADMIN_CANCEL":
      credit = event.salonAtFault ? p.salonCancelCreditMinor : 0;
      reasonCode = event.salonAtFault ? "ADMIN_CANCEL_SALON_FAULT" : "ADMIN_CANCEL";
      break;
    default:
      reasonCode = event.kind;
  }
  if (paid <= 0) return { feeMinor: 0, feePercent: 0, refundMinor: 0, salonShareMinor: 0, platformShareMinor: 0, salonCreditMinor: 0, reasonCode: "NOT_PAID" };

  const feeMinor = Math.min(paid, roundToTaka((paid * pct) / 100));
  return {
    feeMinor,
    feePercent: pct,
    refundMinor: paid - feeMinor,
    ...splitFee(feeMinor, p.feeSalonSharePercent),
    salonCreditMinor: credit,
    reasonCode,
  };
};

// ---------------------------------------------------------------------------
// The settlement
// ---------------------------------------------------------------------------

/**
 * In the transaction that ended the visit. The refund goes back to the
 * customer's available balance, the fee leaves the wallet (salon share →
 * the booked salon's SALON_PAYABLE, pending like any earning; the rest →
 * platform revenue), the salon's credit moves salon → customer (it may leave
 * the business in dues), and a balance paid in the app is released whole.
 * Idempotent through `advanceStatus`: only a HELD advance is settled.
 */
export const settleHomeEndTx = async (tx: Tx, bookingId: string, outcome: Outcome) => {
  const b = await tx.homeBooking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      code: true,
      customerId: true,
      salonId: true,
      advanceMinor: true,
      advanceStatus: true,
      balanceMinor: true,
      balanceMethod: true,
      salon: { select: { ownerId: true } },
    },
  });
  if (!b || b.advanceStatus !== AdvanceStatus.HELD) return null;
  if (outcome.feeMinor + outcome.refundMinor !== b.advanceMinor) {
    throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, `Home visit ${b.code}: fee + refund does not equal the advance`);
  }

  const label = `Home visit ${b.code}`;
  const ref = { referenceType: "HOME_BOOKING", referenceId: b.id, settlesHoldOf: b.id };
  const balanceHeldMinor = b.balanceMethod === BalanceMethod.WALLET ? b.balanceMinor : 0;
  const releaseMinor = outcome.refundMinor + balanceHeldMinor;

  if (releaseMinor > 0) {
    await WalletService.mutate(
      {
        ...ref,
        userId: b.customerId,
        type: WalletTxType.DEPOSIT_RELEASE,
        amount: 0,
        holdDelta: -releaseMinor,
        description: `${label} - money returned to your wallet`,
        idempotencyKey: `homerelease:${b.id}`,
        metadata: { holdDeltaMinor: -releaseMinor, advanceMinor: outcome.refundMinor, balanceMinor: balanceHeldMinor },
      },
      tx,
    );
  }
  if (outcome.feeMinor > 0) {
    await WalletService.mutate(
      {
        ...ref,
        userId: b.customerId,
        type: WalletTxType.DEPOSIT_FORFEIT,
        amount: -outcome.feeMinor,
        holdDelta: -outcome.feeMinor,
        description: `${label} - cancellation fee (${outcome.feePercent}% of the advance)`,
        idempotencyKey: `homefee:${b.id}`,
        metadata: { holdDeltaMinor: -outcome.feeMinor },
      },
      tx,
    );
  }
  if (outcome.salonCreditMinor > 0) {
    await WalletService.mutate(
      {
        userId: b.customerId,
        type: WalletTxType.GOODWILL_CREDIT,
        amount: outcome.salonCreditMinor,
        description: `${label} - credit from the salon for cancelling`,
        referenceType: "HOME_BOOKING",
        referenceId: b.id,
        idempotencyKey: `homecredit:${b.id}`,
      },
      tx,
    );
  }

  await writeJournal(tx, {
    homeBookingId: b.id,
    salonId: b.salonId,
    ownerId: b.salon.ownerId,
    kind: "home.ended",
    drafts: [
      { account: LedgerAccount.CUSTOMER_WALLET, amountMinor: -outcome.feeMinor, description: `Cancellation fee - ${label}` },
      { account: LedgerAccount.SALON_PAYABLE, amountMinor: outcome.salonShareMinor, description: `Salon share of the fee - ${label}` },
      { account: LedgerAccount.PLATFORM_REVENUE, amountMinor: outcome.platformShareMinor, description: `Platform share of the fee - ${label}` },
      { account: LedgerAccount.SALON_PAYABLE, amountMinor: -outcome.salonCreditMinor, description: `Credit to the customer - ${label}` },
      { account: LedgerAccount.CUSTOMER_WALLET, amountMinor: outcome.salonCreditMinor, description: `Credit from the salon - ${label}` },
    ],
  });

  const advanceStatus =
    outcome.feeMinor === 0
      ? AdvanceStatus.RELEASED
      : outcome.feeMinor === b.advanceMinor
        ? AdvanceStatus.FORFEITED
        : AdvanceStatus.PARTIALLY_FORFEITED;
  await tx.homeBooking.update({
    where: { id: b.id },
    data: { feeMinor: outcome.feeMinor, refundedMinor: outcome.refundMinor, advanceStatus },
  });
  return { releasedMinor: releaseMinor, balanceReleasedMinor: balanceHeldMinor, advanceStatus };
};

// ---------------------------------------------------------------------------
// Ending a visit
// ---------------------------------------------------------------------------

const END_STATE: Record<
  EndEvent["kind"],
  { to: HomeBookingStatus; cancelledBy?: CancelledBy; noShowParty?: HomeNoShowParty }
> = {
  CUSTOMER_CANCEL: { to: HomeBookingStatus.CANCELLED, cancelledBy: CancelledBy.CUSTOMER },
  CUSTOMER_NO_SHOW: { to: HomeBookingStatus.NO_SHOW, noShowParty: HomeNoShowParty.CUSTOMER },
  // The expert ended it at the door; the reason code says whose fault.
  MISMATCH_ABORT: { to: HomeBookingStatus.CANCELLED, cancelledBy: CancelledBy.SALON },
  SAFETY_ABORT: { to: HomeBookingStatus.CANCELLED, cancelledBy: CancelledBy.SALON },
  SALON_CANCEL: { to: HomeBookingStatus.CANCELLED, cancelledBy: CancelledBy.SALON },
  EXPERT_NO_SHOW: { to: HomeBookingStatus.NO_SHOW, noShowParty: HomeNoShowParty.EXPERT },
  ADMIN_CANCEL: { to: HomeBookingStatus.CANCELLED, cancelledBy: CancelledBy.ADMIN },
  SYSTEM_CANCEL: { to: HomeBookingStatus.CANCELLED, cancelledBy: CancelledBy.SYSTEM },
};

type EndArgs = {
  id: string;
  event: EndEvent;
  /** The statuses this end may start from. */
  from: HomeBookingStatus[];
  actorId: string | null;
  actorRole: string;
  reason: string | null;
  /** Extra checks on the row read inside the transaction (time rules). */
  check?: (b: EndRow) => void;
  audit?: { ctx: AuditCtx | undefined; action: string };
  /** Runs inside the transaction after the settlement (safety report, ...). */
  after?: (tx: Tx, b: EndRow) => Promise<void>;
};

const END_ROW = {
  id: true,
  code: true,
  status: true,
  customerId: true,
  salonId: true,
  expertId: true,
  startAt: true,
  arrivedAt: true,
  confirmedAt: true,
  advanceMinor: true,
  advanceStatus: true,
  policySnapshot: true,
} satisfies Prisma.HomeBookingSelect;

type EndRow = Prisma.HomeBookingGetPayload<{ select: typeof END_ROW }>;

/**
 * The one way a visit ends early: the conditional move + event, the
 * settlement, the side effects and the audit, in one transaction. A status
 * that changed under us fails the move (INVALID_STATE) and nothing is kept.
 */
export const endVisitTx = async (tx: Tx, args: EndArgs) => {
  const { to, cancelledBy, noShowParty } = END_STATE[args.event.kind];
  const b = await tx.homeBooking.findUnique({ where: { id: args.id }, select: END_ROW });
  if (!b) throw notFound();
  if (!args.from.includes(b.status)) throw invalidState();
  args.check?.(b);

  const outcome = decideOutcome(b, args.event);
  const now = new Date();
  await moveTx(tx, b.id, {
    from: b.status,
    to,
    actorId: args.actorId,
    actorRole: args.actorRole,
    reason: args.reason ? `${outcome.reasonCode}: ${args.reason}` : outcome.reasonCode,
    data:
      to === HomeBookingStatus.CANCELLED
        ? { cancelledAt: now, cancelledBy, cancelReason: args.reason }
        : { noShowParty, noShowMarkedAt: now },
  });
  const settled = await settleHomeEndTx(tx, b.id, outcome);

  if (args.event.kind === "SALON_CANCEL") {
    await tx.homeExpert.update({ where: { id: b.expertId }, data: { cancelledBySalon: { increment: 1 } } });
  }
  if (args.event.kind === "CUSTOMER_NO_SHOW") await applyNoShowBlockTx(tx, b.customerId, now);
  await args.after?.(tx, b);
  if (args.audit) {
    await auditTx(tx, args.audit.ctx, {
      action: args.audit.action,
      entityType: "HomeBooking",
      entityId: b.id,
      salonId: b.salonId,
      before: { status: b.status, advanceStatus: b.advanceStatus },
      after: { status: to, ...outcome },
      reason: args.reason,
    });
  }
  return {
    bookingId: b.id,
    code: b.code,
    status: to,
    outcome,
    balanceReleasedMinor: settled?.balanceReleasedMinor ?? 0,
  };
};

export const endVisit = (args: EndArgs) =>
  prisma.$transaction((tx) => endVisitTx(tx, args), { maxWait: 10_000, timeout: 20_000 });

/** One end per booking, each in its own transaction; a failure is counted, not thrown. */
const endMany = async (ids: string[], make: (id: string) => EndArgs) => {
  let cancelled = 0;
  let refundedMinor = 0;
  const failed: string[] = [];
  for (const id of ids) {
    try {
      const r = await endVisit(make(id));
      cancelled++;
      refundedMinor += r.outcome.refundMinor + r.balanceReleasedMinor;
    } catch (e) {
      if (!(e instanceof ApiError)) console.error(`[home] end ${id}`, e);
      failed.push(id);
    }
  }
  return { cancelled, refundedMinor, failed };
};

// ---------------------------------------------------------------------------
// No-show block
// ---------------------------------------------------------------------------

/**
 * After a customer no-show: `noShowBlockThreshold` (> 0) no-shows in 30 days
 * bar the customer for `noShowBlockDays`. An upheld appeal doesn't count. A
 * longer block already in place is kept.
 */
const applyNoShowBlockTx = async (tx: Tx, userId: string, now: Date) => {
  const [threshold, days] = await Promise.all([
    getSetting("homeService.noShowBlockThreshold"),
    getSetting("homeService.noShowBlockDays"),
  ]);
  if (threshold <= 0 || days <= 0) return;
  const count = await countNoShowsTx(tx, userId, now);
  if (count < threshold) return;
  const until = new Date(now.getTime() + days * DAY_MS);
  const existing = await tx.homeCustomerBlock.findUnique({ where: { userId }, select: { until: true } });
  if (existing && existing.until >= until) return;
  const reason = `${count} missed home visits in 30 days`;
  await tx.homeCustomerBlock.upsert({
    where: { userId },
    create: { userId, until, reason, source: "NO_SHOWS" },
    update: { until, reason, source: "NO_SHOWS", createdById: null },
  });
};

const countNoShowsTx = (tx: Tx, userId: string, now: Date) =>
  tx.homeBooking.count({
    where: {
      customerId: userId,
      status: HomeBookingStatus.NO_SHOW,
      noShowParty: HomeNoShowParty.CUSTOMER,
      noShowMarkedAt: { gte: new Date(now.getTime() - 30 * DAY_MS) },
      OR: [{ appealStatus: null }, { appealStatus: { not: AppealStatus.APPROVED } }],
    },
  });

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

const QUOTE_ROW = {
  ...END_ROW,
  rescheduleCount: true,
  balanceMinor: true,
  balanceMethod: true,
} satisfies Prisma.HomeBookingSelect;

const loadOwn = async (userId: string, id: string) => {
  const b = await prisma.homeBooking.findFirst({ where: { id, customerId: userId }, select: QUOTE_ROW });
  if (!b) throw notFound();
  return b;
};

/** Why the visit can't be moved, or null when it can. */
const rescheduleBlock = (
  b: { status: HomeBookingStatus; startAt: Date; rescheduleCount: number; policySnapshot: unknown },
  cutoffHours: number,
  now: Date,
): string | null => {
  if (b.status !== HomeBookingStatus.CONFIRMED) return "Only a confirmed visit that hasn't started can be moved.";
  if (b.startAt.getTime() - now.getTime() < cutoffHours * HOUR_MS) {
    return `A visit can be moved until ${cutoffHours} hours before it starts.`;
  }
  const max = snapshotOf(b.policySnapshot).maxRescheduleCount;
  if (b.rescheduleCount >= max) {
    return max === 0 ? "This booking can't be moved." : max === 1 ? "This visit was already moved once." : `This visit was already moved ${max} times.`;
  }
  return null;
};

const cancelMessage = (o: Outcome, advanceMinor: number, balanceBackMinor: number) => {
  const head =
    o.reasonCode === "NOT_PAID"
      ? "Nothing was paid for this booking"
      : o.feeMinor === 0
        ? `Free cancellation — ${formatBDT(o.refundMinor)} back to your wallet`
        : o.refundMinor === 0
          ? `Your ${formatBDT(advanceMinor)} advance is non-refundable — you get ৳0 back`
          : `${formatBDT(o.feeMinor)} of your ${formatBDT(advanceMinor)} advance is kept — ${formatBDT(o.refundMinor)} back to your wallet`;
  return balanceBackMinor > 0 ? `${head}. The ${formatBDT(balanceBackMinor)} balance you paid comes back too.` : head;
};

export const cancelQuote = async (userId: string, id: string) => {
  const b = await loadOwn(userId, id);
  const now = new Date();
  const canCancel = CUSTOMER_CANCELLABLE.includes(b.status);
  const outcome = decideOutcome(b, { kind: "CUSTOMER_CANCEL", now });
  const balanceBackMinor = b.balanceMethod === BalanceMethod.WALLET && b.advanceStatus === AdvanceStatus.HELD ? b.balanceMinor : 0;
  const cutoff = await getSetting("homeService.rescheduleCutoffHours");
  const blocked = rescheduleBlock(b, cutoff, now);
  return {
    canCancel,
    outcome,
    advanceMinor: b.advanceMinor,
    balanceBackMinor,
    message: canCancel ? cancelMessage(outcome, b.advanceMinor, balanceBackMinor) : "This visit can't be cancelled now.",
    canReschedule: !blocked,
    rescheduleBlockedReason: blocked,
    policy: snapshotOf(b.policySnapshot).policy,
  };
};

export const customerCancel = async (actor: Actor, id: string, reason?: string) => {
  if (actor.impersonating) throw readOnly();
  await loadOwn(actor.userId, id);
  const result = await endVisit({
    id,
    event: { kind: "CUSTOMER_CANCEL", now: new Date() },
    from: CUSTOMER_CANCELLABLE,
    actorId: actor.userId,
    actorRole: "CUSTOMER",
    reason: reason?.trim() || null,
  });
  return { ...result, booking: await getBooking(actor.userId, id) };
};

// ---------------------------------------------------------------------------
// Reschedule
// ---------------------------------------------------------------------------

const notAllowed = (message: string) => fail(StatusCodes.CONFLICT, message, "RESCHEDULE_NOT_ALLOWED");

/**
 * A CONFIRMED visit to another start (same expert, or "ANY" free expert of
 * the branch), inside the window counted from today, under the stylist lock.
 * The advance stays held; the overlap exclusion backs the check up.
 */
export const reschedule = async (actor: Actor, id: string, body: RescheduleBody) => {
  if (actor.impersonating) throw readOnly();
  const b = await prisma.homeBooking.findFirst({
    where: { id, customerId: actor.userId },
    select: {
      ...QUOTE_ROW,
      endAt: true,
      blockFrom: true,
      blockTo: true,
      audience: true,
      items: { select: { offeringId: true } },
      salon: { select: { status: true, isDeleted: true, bookingPause: true } },
    },
  });
  if (!b) throw notFound();
  const now = new Date();
  const blocked = rescheduleBlock(b, await getSetting("homeService.rescheduleCutoffHours"), now);
  if (blocked) throw notAllowed(blocked);

  const startAt = new Date(body.startAt);
  if (dhakaDay(startAt) !== body.date) throw fail(StatusCodes.BAD_REQUEST, "The time isn't on the day you picked.", "INVALID_TIME");
  if (startAt.getTime() === b.startAt.getTime() && (!body.expertId || body.expertId === b.expertId)) {
    throw notAllowed("Pick a different time.");
  }

  const [flags, profile] = await Promise.all([
    loadHomeFlags(),
    prisma.homeServiceProfile.findUnique({ where: { salonId: b.salonId } }),
  ]);
  if (
    b.salon.isDeleted ||
    b.salon.status !== SalonStatus.ACTIVE ||
    b.salon.bookingPause !== BookingPause.NONE ||
    !isBranchBookable(profile, b.salon, b.audience, flags, now)
  ) {
    throw notAllowed("This salon isn't taking new home visit times right now. You can still cancel.");
  }

  const offeringIds = b.items.map((i) => i.offeringId);
  let candidates: string[];
  if (!body.expertId) candidates = [b.expertId];
  else if (body.expertId === "ANY") {
    const all = (await eligibleExperts({ salonId: b.salonId, audience: b.audience, offeringIds })).map((e) => e.id);
    candidates = all.includes(b.expertId) ? [b.expertId, ...all.filter((x) => x !== b.expertId)] : all;
  } else candidates = [body.expertId];

  const durationMs = b.endAt.getTime() - b.startAt.getTime();
  const before = b.startAt.getTime() - b.blockFrom.getTime();
  const after = b.blockTo.getTime() - b.endAt.getTime();
  const endAt = new Date(startAt.getTime() + durationMs);
  const blockFrom = new Date(startAt.getTime() - before);
  const blockTo = new Date(endAt.getTime() + after);
  const taken = () =>
    body.expertId === "ANY"
      ? fail(StatusCodes.CONFLICT, "No expert is free at that time. Pick another.", "NO_EXPERT_FREE")
      : fail(StatusCodes.CONFLICT, "This time isn't free. Pick another.", "SLOT_TAKEN");

  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '8s'`;
        let chosen: { id: string; audience: typeof b.audience } | null = null;
        for (const expertId of candidates) {
          const e = await tx.homeExpert.findUnique({ where: { id: expertId }, select: { id: true, staffId: true, salonId: true, audience: true } });
          if (!e || e.salonId !== b.salonId || e.audience !== b.audience) continue;
          await lockStaff(tx, e.staffId);
          await expireStaleOf(tx, e.id);
          const clash = await tx.homeBooking.findFirst({
            where: {
              id: { not: b.id },
              expertId: e.id,
              status: { in: [...UPCOMING, ...UNDER_WAY] },
              blockFrom: { lt: blockTo },
              blockTo: { gt: blockFrom },
            },
            select: { id: true },
          });
          if (clash) continue;
          // Measured from now: lead time and the window from today.
          const { ok } = await expertCanTake({ expertId: e.id, offeringIds, startAt, excludeBookingId: b.id, db: tx }).catch(
            (err) => {
              if (err instanceof ApiError && candidates.length > 1) return { ok: false };
              throw err;
            },
          );
          if (ok) {
            chosen = { id: e.id, audience: e.audience };
            break;
          }
        }
        if (!chosen) throw taken();

        const n = await tx.homeBooking.updateMany({
          where: { id: b.id, status: HomeBookingStatus.CONFIRMED, startAt: b.startAt, rescheduleCount: b.rescheduleCount },
          data: {
            startAt,
            endAt,
            blockFrom,
            blockTo,
            serviceDate: new Date(`${body.date}T00:00:00Z`),
            expertId: chosen.id,
            expertAudience: chosen.audience,
            rescheduleCount: { increment: 1 },
            startCodeTries: 0,
            reminder24At: null,
            reminder2hAt: null,
          },
        });
        if (!n.count) throw invalidState();
        await tx.homeBookingEvent.create({
          data: {
            bookingId: b.id,
            fromStatus: HomeBookingStatus.CONFIRMED,
            toStatus: HomeBookingStatus.CONFIRMED,
            actorId: actor.userId,
            actorRole: "CUSTOMER",
            reason: `Rescheduled from ${b.startAt.toISOString()} to ${startAt.toISOString()}${chosen.id !== b.expertId ? " (new expert)" : ""}`,
          },
        });
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
  } catch (e) {
    if (isExclusionViolation(e) || isContention(e)) throw taken();
    throw e;
  }
  return getBooking(actor.userId, id);
};

// ---------------------------------------------------------------------------
// Expert at the door
// ---------------------------------------------------------------------------

const myJob = async (userId: string, id: string) => {
  const b = await prisma.homeBooking.findFirst({ where: { id, expert: { staff: { userId } } }, select: { id: true } });
  if (!b) throw new ApiError(StatusCodes.NOT_FOUND, "Job not found");
};

/** ARRIVED and `noShowWaitMinutes` waited at the door → NO_SHOW (CUSTOMER). */
export const expertMarkNoShow = async (userId: string, id: string) => {
  await myJob(userId, id);
  const wait = await getSetting("homeService.noShowWaitMinutes");
  return endVisit({
    id,
    event: { kind: "CUSTOMER_NO_SHOW" },
    from: [HomeBookingStatus.ARRIVED],
    actorId: userId,
    actorRole: "EXPERT",
    reason: `Waited ${wait} minutes at the door`,
    check: (b) => {
      const from = (b.arrivedAt ?? new Date()).getTime() + wait * MIN_MS;
      if (Date.now() < from) {
        throw invalidState(`Wait ${wait} minutes after arriving before marking the customer as not home.`);
      }
    },
  });
};

/**
 * The expert stops the visit. MISMATCH (not the person or place booked) is
 * charged like a no-show; SAFETY is a full refund and opens a safety report
 * for the review queue.
 */
export const expertAbort = async (userId: string, id: string, kind: "MISMATCH" | "SAFETY", reason: string) => {
  await myJob(userId, id);
  return endVisit({
    id,
    event: { kind: kind === "SAFETY" ? "SAFETY_ABORT" : "MISMATCH_ABORT" },
    from: kind === "SAFETY" ? UNDER_WAY : [HomeBookingStatus.ARRIVED, HomeBookingStatus.IN_PROGRESS],
    actorId: userId,
    actorRole: "EXPERT",
    reason,
    after: async (tx, b) => {
      if (kind !== "SAFETY") return;
      await tx.homeSafetyReport.create({
        data: { bookingId: b.id, reporterId: userId, reporterRole: "EXPERT", kind: HomeSafetyKind.SAFETY, details: reason },
      });
    },
  });
};

// ---------------------------------------------------------------------------
// Owner (homeservice.bookings) and admin
// ---------------------------------------------------------------------------

const boardBooking = async (user: AccessUser, id: string) => {
  const b = await prisma.homeBooking.findUnique({ where: { id }, select: { salonId: true, status: true } });
  if (!b || b.status === HomeBookingStatus.PENDING_PAYMENT || b.status === HomeBookingStatus.EXPIRED) throw notFound();
  await assertSalonPermission(user, b.salonId, "homeservice.bookings");
};

const expertLateCheck = (b: EndRow) => {
  if (Date.now() < b.startAt.getTime() + EXPERT_NO_SHOW_AFTER_MS) {
    throw invalidState("An expert can be marked as not arrived from 45 minutes after the start.");
  }
};

export const ownerCancel = async (user: AccessUser, ctx: AuditCtx, id: string, reason: string) => {
  await boardBooking(user, id);
  const result = await endVisit({
    id,
    event: { kind: "SALON_CANCEL" },
    from: CUSTOMER_CANCELLABLE,
    actorId: ctx.actorUserId,
    actorRole: user.role,
    reason,
    audit: { ctx, action: "homeService.booking_salon_cancel" },
  });
  return { ...result, booking: await getBoardBooking(id) };
};

export const ownerExpertNoShow = async (user: AccessUser, ctx: AuditCtx, id: string, reason: string) => {
  await boardBooking(user, id);
  const result = await endVisit({
    id,
    event: { kind: "EXPERT_NO_SHOW" },
    from: EXPERT_LATE_STATUSES,
    actorId: ctx.actorUserId,
    actorRole: user.role,
    reason,
    check: expertLateCheck,
    audit: { ctx, action: "homeService.booking_expert_no_show" },
  });
  return { ...result, booking: await getBoardBooking(id) };
};

export const adminExpertNoShow = (ctx: AuditCtx | undefined, id: string, reason: string) =>
  endVisit({
    id,
    event: { kind: "EXPERT_NO_SHOW" },
    from: EXPERT_LATE_STATUSES,
    actorId: ctx?.actorUserId ?? null,
    actorRole: "ADMIN",
    reason,
    check: expertLateCheck,
    audit: { ctx, action: "homeService.booking_expert_no_show" },
  });

export const adminCancel = (ctx: AuditCtx | undefined, id: string, reason: string, salonAtFault: boolean) =>
  endVisit({
    id,
    event: { kind: "ADMIN_CANCEL", salonAtFault },
    from: ADMIN_CANCELLABLE,
    actorId: ctx?.actorUserId ?? null,
    actorRole: "ADMIN",
    reason,
    audit: { ctx, action: "homeService.booking_admin_cancel" },
  });

// ---------------------------------------------------------------------------
// Branch and expert level ends
// ---------------------------------------------------------------------------

type BulkActor = { ctx: AuditCtx | undefined; actorRole: string; reason: string; action: string };

const bulkArgs =
  (event: EndEvent, a: BulkActor) =>
  (id: string): EndArgs => ({
    id,
    event,
    from: UPCOMING,
    actorId: a.ctx?.actorUserId ?? null,
    actorRole: a.actorRole,
    reason: a.reason,
    audit: { ctx: a.ctx, action: a.action },
  });

/**
 * Every upcoming visit of a branch ends with a full refund (turn-off CANCEL:
 * SALON_CANCEL; admin suspend: SYSTEM_CANCEL). Visits already under way go
 * ahead and are counted in `underWay`.
 */
export const cancelBranchUpcoming = async (salonId: string, kind: "SALON_CANCEL" | "SYSTEM_CANCEL", a: BulkActor) => {
  const [rows, underWay] = await Promise.all([
    prisma.homeBooking.findMany({ where: { salonId, status: { in: UPCOMING } }, select: { id: true }, orderBy: { startAt: "asc" } }),
    prisma.homeBooking.count({ where: { salonId, status: { in: UNDER_WAY } } }),
  ]);
  const r = await endMany(
    rows.map((x) => x.id),
    bulkArgs({ kind }, a),
  );
  return { ...r, underWay };
};

/**
 * An expert leaves (suspended, removed, side changed): each upcoming visit
 * goes to another free expert of the same branch and side who does every
 * item, else ends with a full refund (`fallback`). Unpaid ones just end.
 */
export const rehomeExpertBookings = async (expertId: string, fallback: "SALON_CANCEL" | "SYSTEM_CANCEL", a: BulkActor) => {
  const [rows, underWay] = await Promise.all([
    prisma.homeBooking.findMany({
      where: { expertId, status: { in: UPCOMING } },
      select: {
        id: true,
        status: true,
        salonId: true,
        audience: true,
        expertId: true,
        startAt: true,
        blockFrom: true,
        blockTo: true,
        createdAt: true,
        items: { select: { offeringId: true } },
      },
      orderBy: { startAt: "asc" },
    }),
    prisma.homeBooking.count({ where: { expertId, status: { in: UNDER_WAY } } }),
  ]);

  let reassigned = 0;
  const toEnd: string[] = [];
  for (const b of rows) {
    if (b.status !== HomeBookingStatus.CONFIRMED) {
      toEnd.push(b.id);
      continue;
    }
    const offeringIds = b.items.map((i) => i.offeringId);
    const others = (await eligibleExperts({ salonId: b.salonId, audience: b.audience, offeringIds }).catch(() => [])).filter(
      (e) => e.id !== expertId,
    );
    let moved = false;
    for (const other of others) {
      const target = await prisma.homeExpert.findUnique({
        where: { id: other.id },
        select: { id: true, staffId: true, audience: true, staff: { select: { user: { select: { name: true } } } } },
      });
      if (!target) continue;
      try {
        await prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`SET LOCAL lock_timeout = '8s'`;
            await moveToExpertTx(tx, { ...b, offeringIds }, target, {
              actorId: a.ctx?.actorUserId ?? null,
              actorRole: a.actorRole,
              reason: `Reassigned to ${target.staff.user.name}: ${a.reason}`,
            });
            await auditTx(tx, a.ctx, {
              action: "homeService.booking_reassign",
              entityType: "HomeBooking",
              entityId: b.id,
              salonId: b.salonId,
              before: { expertId },
              after: { expertId: target.id },
              reason: a.reason,
            });
          },
          { maxWait: 10_000, timeout: 20_000 },
        );
        moved = true;
        break;
      } catch (e) {
        if (e instanceof ApiError || isExclusionViolation(e) || isContention(e)) continue;
        throw e;
      }
    }
    if (moved) reassigned++;
    else toEnd.push(b.id);
  }

  const r = await endMany(toEnd, bulkArgs({ kind: fallback }, a));
  return { reassigned, ...r, underWay };
};

// ---------------------------------------------------------------------------
// Appeals
// ---------------------------------------------------------------------------

/** A kept fee can be appealed once, within `appealWindowHours` of the end. */
export const appeal = async (actor: Actor, id: string, reason: string) => {
  if (actor.impersonating) throw readOnly();
  const b = await prisma.homeBooking.findFirst({
    where: { id, customerId: actor.userId },
    select: { id: true, status: true, feeMinor: true, appealStatus: true, cancelledAt: true, noShowMarkedAt: true, policySnapshot: true },
  });
  if (!b) throw notFound();
  if (b.feeMinor <= 0) throw invalidState("Nothing was kept on this booking, so there is nothing to appeal.");
  if (b.appealStatus) throw invalidState("You already appealed this booking.");
  const endedAt = b.cancelledAt ?? b.noShowMarkedAt;
  const hours = snapshotOf(b.policySnapshot).appealWindowHours;
  if (!endedAt || Date.now() > endedAt.getTime() + hours * HOUR_MS) {
    throw invalidState(`Appeals are open for ${hours} hours after the visit ends.`);
  }
  const n = await prisma.homeBooking.updateMany({
    where: { id, appealStatus: null, feeMinor: { gt: 0 } },
    data: { appealStatus: AppealStatus.PENDING, appealedAt: new Date(), appealReason: reason },
  });
  if (!n.count) throw invalidState("You already appealed this booking.");
  return getBooking(actor.userId, id);
};

/**
 * Reverses the kept fee: back to the customer's wallet, taken back from the
 * salon and the platform in the same shares (recomputed from the immutable
 * snapshot, so it always mirrors the original journal).
 */
export const reverseFeeTx = async (tx: Tx, id: string) => {
  const b = await tx.homeBooking.findUnique({
    where: { id },
    select: { id: true, code: true, customerId: true, salonId: true, feeMinor: true, refundedMinor: true, policySnapshot: true, salon: { select: { ownerId: true } } },
  });
  if (!b || b.feeMinor <= 0) return null;
  const { salonShareMinor, platformShareMinor } = splitFee(b.feeMinor, snapshotOf(b.policySnapshot).feeSalonSharePercent);
  const label = `Home visit ${b.code}`;
  await WalletService.mutate(
    {
      userId: b.customerId,
      type: WalletTxType.REFUND,
      amount: b.feeMinor,
      description: `${label} - fee returned on appeal`,
      referenceType: "HOME_BOOKING",
      referenceId: b.id,
      idempotencyKey: `homeappeal:${b.id}`,
    },
    tx,
  );
  await writeJournal(tx, {
    homeBookingId: b.id,
    salonId: b.salonId,
    ownerId: b.salon.ownerId,
    kind: "home.fee_reversed",
    drafts: [
      { account: LedgerAccount.CUSTOMER_WALLET, amountMinor: b.feeMinor, description: `Fee returned on appeal - ${label}` },
      { account: LedgerAccount.SALON_PAYABLE, amountMinor: -salonShareMinor, description: `Salon share reversed on appeal - ${label}` },
      { account: LedgerAccount.PLATFORM_REVENUE, amountMinor: -platformShareMinor, description: `Platform share reversed on appeal - ${label}` },
    ],
  });
  // Nothing is kept any more (CHECK: fee + refunded ≤ advance); the appeal and the audit row say why.
  await tx.homeBooking.update({
    where: { id: b.id },
    data: { advanceStatus: AdvanceStatus.RELEASED, feeMinor: 0, refundedMinor: (b.refundedMinor ?? 0) + b.feeMinor },
  });
  return { refundedMinor: b.feeMinor, salonShareMinor, platformShareMinor };
};

export const resolveAppeal = async (ctx: AuditCtx | undefined, id: string, approve: boolean, note?: string) =>
  prisma.$transaction(async (tx) => {
    const b = await tx.homeBooking.findUnique({
      where: { id },
      select: { id: true, salonId: true, customerId: true, feeMinor: true, appealStatus: true, noShowParty: true },
    });
    if (!b) throw notFound();
    const n = await tx.homeBooking.updateMany({
      where: { id, appealStatus: AppealStatus.PENDING },
      data: {
        appealStatus: approve ? AppealStatus.APPROVED : AppealStatus.REJECTED,
        appealResolvedAt: new Date(),
        appealResolvedById: ctx?.actorUserId ?? null,
      },
    });
    if (!n.count) throw invalidState("This appeal was already decided.");
    const reversed = approve ? await reverseFeeTx(tx, id) : null;

    // An upheld no-show no longer counts: lift a no-show block it no longer reaches.
    if (approve && b.noShowParty === HomeNoShowParty.CUSTOMER) {
      const threshold = await getSetting("homeService.noShowBlockThreshold");
      const block = await tx.homeCustomerBlock.findUnique({ where: { userId: b.customerId }, select: { source: true } });
      if (block?.source === "NO_SHOWS" && (threshold <= 0 || (await countNoShowsTx(tx, b.customerId, new Date())) < threshold)) {
        await tx.homeCustomerBlock.delete({ where: { userId: b.customerId } });
      }
    }

    await auditTx(tx, ctx, {
      action: approve ? "homeService.appeal_approve" : "homeService.appeal_reject",
      entityType: "HomeBooking",
      entityId: id,
      salonId: b.salonId,
      before: { appealStatus: AppealStatus.PENDING },
      after: { appealStatus: approve ? AppealStatus.APPROVED : AppealStatus.REJECTED, ...(reversed ?? {}) },
      reason: note ?? null,
    });
    return { id, appealStatus: approve ? AppealStatus.APPROVED : AppealStatus.REJECTED, refundedMinor: reversed?.refundedMinor ?? 0 };
  });

/** Pending home appeals for the admin queue, oldest first (`kind: "HOME"`). */
export const listPendingAppeals = async () => {
  const rows = await prisma.homeBooking.findMany({
    where: { appealStatus: AppealStatus.PENDING },
    orderBy: [{ appealedAt: "asc" }, { id: "asc" }],
    take: 200,
    select: {
      id: true,
      code: true,
      status: true,
      audience: true,
      startAt: true,
      advanceMinor: true,
      feeMinor: true,
      cancelledBy: true,
      cancelReason: true,
      noShowParty: true,
      noShowMarkedAt: true,
      arrivedAt: true,
      appealedAt: true,
      appealReason: true,
      isTest: true,
      customer: { select: { id: true, name: true, isTest: true } },
      salon: { select: { id: true, name: true, area: true, isTest: true } },
      items: { select: { nameSnapshot: true } },
    },
  });
  return rows.map(({ items, ...r }) => ({
    kind: "HOME" as const,
    ...r,
    services: items.map((i) => i.nameSnapshot),
    // Same promise as salon appeals: decided within 48 h of the appeal.
    dueAt: r.appealedAt ? new Date(r.appealedAt.getTime() + 48 * HOUR_MS) : null,
  }));
};
