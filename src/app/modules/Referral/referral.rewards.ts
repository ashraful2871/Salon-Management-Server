import { AppealStatus, AppointmentStatus, Prisma, RewardStatus } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { formatBDT } from "../../utils/money";
import {
  bdPhone,
  pickBest,
  rewardLabel,
  type Applied,
  type BookingKind,
  type NotApplicable,
  type RewardTerms,
} from "./referral.math";
import { hmac } from "./referral.risk";
import { loadReferralSettings } from "./referral.settings";
import { countAfterCommit } from "./referral.metrics";

/**
 * Rewards on bookings, shared by salon appointments and home visits: quote,
 * reserve, release, consume, redeem, restore. Every transition is a
 * conditional `updateMany` plus a `ReferralEvent` row. Booking code reaches the
 * end-of-booking ones through `referral.lifecycle.ts`; it calls `quotePromo`
 * and `reserveTx` here directly.
 */

type Db = Prisma.TransactionClient | typeof prisma;

/** Which booking holds a reward. */
export type BookingRef = { appointmentId: string } | { homeBookingId: string };

const refWhere = (ref: BookingRef) =>
  "appointmentId" in ref ? { appointmentId: ref.appointmentId } : { homeBookingId: ref.homeBookingId };

/** What a released / restored reward drops: it no longer belongs to a booking. */
const DETACH = {
  appointmentId: null,
  homeBookingId: null,
  discountMinor: 0,
  phoneHash: null,
  reservedAt: null,
  redeemedAt: null,
} as const;

const WELCOME = "REFEREE_WELCOME";

/* ------------------------------------------------------------- candidates */

/**
 * The customer's usable rewards (AVAILABLE, not expired), how many bookings
 * they have completed (appointments + home visits, for the first-booking rule)
 * and the HMAC of their `01XXXXXXXXX` phone. The hash is only worked out when a
 * welcome reward needs it, so a server without `REFERRAL_HASH_SECRET` still
 * quotes everyone else.
 */
export const loadCandidates = async (userId: string, db: Db = prisma) => {
  const now = new Date();
  const [rewards, appointments, homeVisits, user] = await Promise.all([
    db.referralReward.findMany({
      where: { userId, status: RewardStatus.AVAILABLE, expiresAt: { gt: now } },
      orderBy: { expiresAt: "asc" },
    }),
    db.appointment.count({ where: { customerId: userId, status: AppointmentStatus.COMPLETED } }),
    db.homeBooking.count({ where: { customerId: userId, status: "COMPLETED" } }),
    db.user.findUnique({ where: { id: userId }, select: { phone: true } }),
  ]);
  const phone = bdPhone(user?.phone);
  const phoneHash = phone && rewards.some((r) => r.kind === WELCOME) ? hmac(phone) : null;
  return { now, rewards, completedBookings: appointments + homeVisits, phone, phoneHash };
};

/* ------------------------------------------------------------------ quote */

export type PromoOption = {
  rewardId: string;
  kind: string;
  label: string;
  /** 5 for 5 % (the reward's snapshot). */
  percent: number;
  discountMinor: number;
  expiresAt: Date;
};

export type PromoQuote = {
  applied: PromoOption | null;
  /** Every reward that fits this booking, best first. */
  options: PromoOption[];
  /**
   * Server only, never sent to a client: the phone hash `reserveTx` writes when
   * the applied reward is a welcome reward (null otherwise).
   */
  phoneHash: string | null;
};

type PhoneBlock = "PHONE_REQUIRED" | "PHONE_REUSED";

const MATH_MESSAGES: Record<NotApplicable, (r: RewardTerms, kind: BookingKind) => string> = {
  EXPIRED: () => "This reward has expired.",
  FIRST_BOOKING_DONE: () => "This reward is for your first booking only.",
  SCOPE: (_r, kind) =>
    kind === "SALON" ? "This reward can't be used on salon bookings." : "This reward can't be used on home visits.",
  MIN_ORDER: (r) => `This reward needs a booking of at least ${formatBDT(r.minOrderMinor)}.`,
  TOO_SMALL: () => "This booking is too small for this reward.",
};

const PHONE_MESSAGES: Record<PhoneBlock, string> = {
  PHONE_REQUIRED: "Add a valid Bangladeshi mobile number to your profile to use your welcome reward.",
  PHONE_REUSED: "A welcome reward has already been used with this phone number.",
};

const notApplicable = (message: string, reason: string, rewardId: string) =>
  ApiError.withCode(StatusCodes.BAD_REQUEST, message, "REWARD_NOT_APPLICABLE", { reason, rewardId });

export const rewardUnavailable = (rewardId?: string) =>
  ApiError.withCode(
    StatusCodes.CONFLICT,
    "This reward is no longer available. Review your booking and try again.",
    "REWARD_UNAVAILABLE",
    rewardId ? { rewardId } : undefined,
  );

const toTerms = (r: {
  id: string;
  kind: string;
  percentBps: number;
  maxDiscountMinor: number;
  minOrderMinor: number;
  scope: string;
  firstBookingOnly: boolean;
  expiresAt: Date;
}): RewardTerms => ({
  id: r.id,
  kind: r.kind,
  percentBps: r.percentBps,
  maxDiscountMinor: r.maxDiscountMinor,
  minOrderMinor: r.minOrderMinor,
  scope: r.scope as RewardTerms["scope"],
  firstBookingOnly: r.firstBookingOnly,
  expiresAt: r.expiresAt,
});

const toOption = (a: Applied): PromoOption => ({
  rewardId: a.reward.id,
  kind: a.reward.kind,
  label: rewardLabel(a.reward.kind, a.reward.percentBps),
  percent: a.reward.percentBps / 100,
  discountMinor: a.discountMinor,
  expiresAt: a.reward.expiresAt,
});

/** Saves `PHONE_REUSED` on the welcome reward's referral, once, with a `flagged` event. */
const flagPhoneReused = async (db: Db, referralId: string | null, rewardId: string) => {
  if (!referralId) return;
  const { count } = await db.referral.updateMany({
    where: { id: referralId, NOT: { riskFlags: { has: "PHONE_REUSED" } } },
    data: { riskFlags: { push: "PHONE_REUSED" } },
  });
  if (count > 0) {
    const ev = await db.referralEvent.create({
      data: { referralId, rewardId, type: "flagged", data: { flags: ["PHONE_REUSED"] } },
    });
    countAfterCommit(ev.id, [{ metric: "flagged", dimension: "flag:phone_reused" }]);
  }
};

/**
 * The reward for this booking, and the others the customer could pick.
 * `requested`: `undefined` = the best one, `null` = none (options still listed),
 * an id = that one, or a 409 `REWARD_UNAVAILABLE` / 400 `REWARD_NOT_APPLICABLE`
 * saying why not. With redemptions switched off nothing is offered, and asking
 * for a particular reward is a `REWARD_NOT_APPLICABLE` (`REDEMPTIONS_OFF`).
 *
 * A welcome reward also needs a valid phone on the account, and no other
 * welcome reward reserved or used on the same phone (the partial unique index
 * `referral_rewards_welcome_phone` enforces it again at reserve).
 */
export const quotePromo = async ({
  userId,
  kind,
  baseMinor,
  requested,
  db = prisma,
}: {
  userId: string;
  kind: BookingKind;
  baseMinor: number;
  requested: string | null | undefined;
  db?: Db;
}): Promise<PromoQuote> => {
  const s = await loadReferralSettings();
  if (!s.redemptionsEnabled) {
    if (typeof requested === "string") {
      throw notApplicable("Rewards can't be used right now.", "REDEMPTIONS_OFF", requested);
    }
    return { applied: null, options: [], phoneHash: null };
  }

  const c = await loadCandidates(userId, db);

  // Welcome rewards the phone rules keep out, checked only when the math would
  // otherwise allow them (so a lapsed reward does not raise a fraud flag).
  const blocked = new Map<string, PhoneBlock>();
  const ctx = { kind, baseMinor, completedBookings: c.completedBookings, now: c.now };
  const first = pickBest(c.rewards.map(toTerms), ctx);
  for (const o of first.options) {
    if (o.reward.kind !== WELCOME) continue;
    if (!c.phoneHash) {
      blocked.set(o.reward.id, "PHONE_REQUIRED");
      continue;
    }
    const reused = await db.referralReward.findFirst({
      where: {
        kind: WELCOME,
        status: { in: [RewardStatus.RESERVED, RewardStatus.REDEEMED] },
        phoneHash: c.phoneHash,
        NOT: { id: o.reward.id },
      },
      select: { id: true },
    });
    if (reused) {
      blocked.set(o.reward.id, "PHONE_REUSED");
      const row = c.rewards.find((r) => r.id === o.reward.id);
      await flagPhoneReused(db, row?.referralId ?? null, o.reward.id);
    }
  }

  const options = first.options.filter((o) => !blocked.has(o.reward.id)).map(toOption);
  const hashFor = (o: PromoOption | null) => (o && o.kind === WELCOME ? c.phoneHash : null);

  if (requested === null) return { applied: null, options, phoneHash: null };
  if (requested === undefined) {
    const applied = options[0] ?? null;
    return { applied, options, phoneHash: hashFor(applied) };
  }

  const applied = options.find((o) => o.rewardId === requested);
  if (applied) return { applied, options, phoneHash: hashFor(applied) };

  const phone = blocked.get(requested);
  if (phone) throw notApplicable(PHONE_MESSAGES[phone], phone, requested);
  const miss = first.notApplicable.find((n) => n.reward.id === requested);
  if (miss) throw notApplicable(MATH_MESSAGES[miss.reason](miss.reward, kind), miss.reason, requested);
  // Not one of the customer's AVAILABLE rewards: used, reserved elsewhere,
  // expired, revoked, held for review, or somebody else's.
  throw rewardUnavailable(requested);
};

/* ---------------------------------------------------------------- reserve */

const isWelcomePhoneClash = (e: unknown) => {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (e.code === "P2002") {
    const target = JSON.stringify(e.meta?.target ?? "");
    return target.includes("phoneHash") || target.includes("welcome_phone") || target === '""';
  }
  return e.code === "P2010" && /23505/.test(e.message) && /welcome_phone/.test(e.message);
};

/**
 * AVAILABLE → RESERVED for this booking, inside the booking transaction, only
 * while it is still the customer's, AVAILABLE and unexpired. 0 rows → 409
 * `REWARD_UNAVAILABLE` (another tab took it first); a welcome reward whose
 * phone already has one in use → 400 `REWARD_NOT_APPLICABLE` (`PHONE_REUSED`).
 * Either throw rolls the booking back with it.
 */
export const reserveTx = async (
  tx: Prisma.TransactionClient,
  r: {
    rewardId: string;
    userId: string;
    appointmentId?: string;
    homeBookingId?: string;
    discountMinor: number;
    phoneHash?: string | null;
  },
) => {
  const now = new Date();
  let count: number;
  try {
    ({ count } = await tx.referralReward.updateMany({
      where: { id: r.rewardId, userId: r.userId, status: RewardStatus.AVAILABLE, expiresAt: { gt: now } },
      data: {
        status: RewardStatus.RESERVED,
        appointmentId: r.appointmentId ?? null,
        homeBookingId: r.homeBookingId ?? null,
        reservedAt: now,
        discountMinor: r.discountMinor,
        phoneHash: r.phoneHash ?? null,
      },
    }));
  } catch (e) {
    if (r.phoneHash && isWelcomePhoneClash(e)) {
      throw notApplicable(PHONE_MESSAGES.PHONE_REUSED, "PHONE_REUSED", r.rewardId);
    }
    throw e;
  }
  if (count === 0) throw rewardUnavailable(r.rewardId);

  const reward = await tx.referralReward.findUniqueOrThrow({
    where: { id: r.rewardId },
    select: { id: true, referralId: true, kind: true },
  });
  await tx.referralEvent.create({
    data: {
      referralId: reward.referralId,
      rewardId: reward.id,
      type: "reserved",
      data: {
        ...(r.appointmentId ? { appointmentId: r.appointmentId } : { homeBookingId: r.homeBookingId }),
        discountMinor: r.discountMinor,
      },
    },
  });
  return reward;
};

/**
 * A visit paid after its window and re-opened from EXPIRED: the expiry gave
 * its reward back, so it is taken again while it is still the customer's,
 * AVAILABLE and unexpired. Best effort and never throws, because the payment
 * must confirm: a reward spent elsewhere in the meantime stays there, and the
 * booking keeps its snapshot discount either way. A welcome reward whose phone
 * is now in use on another booking is left alone (checked first, so no unique
 * violation can abort the payment's transaction).
 */
export const reattachAfterLatePaymentTx = async (tx: Prisma.TransactionClient, ref: BookingRef) => {
  const [key, id] = "appointmentId" in ref ? ["appointmentId", ref.appointmentId] : ["homeBookingId", ref.homeBookingId];
  const released = await tx.referralEvent.findFirst({
    where: { type: "released", data: { path: [key], equals: id } },
    orderBy: { createdAt: "desc" },
    select: { rewardId: true, data: true },
  });
  if (!released?.rewardId) return null;

  const now = new Date();
  const reward = await tx.referralReward.findUnique({ where: { id: released.rewardId } });
  if (!reward || reward.status !== RewardStatus.AVAILABLE || reward.expiresAt.getTime() <= now.getTime()) return null;
  const discountMinor = Number((released.data as { discountMinor?: number } | null)?.discountMinor ?? 0);
  if (!(discountMinor > 0)) return null;

  let phoneHash: string | null = null;
  if (reward.kind === WELCOME) {
    const user = await tx.user.findUnique({ where: { id: reward.userId }, select: { phone: true } });
    const phone = bdPhone(user?.phone);
    if (!phone) return null;
    try {
      phoneHash = hmac(phone);
    } catch {
      return null; // no REFERRAL_HASH_SECRET: never fail a payment over it
    }
    const clash = await tx.referralReward.findFirst({
      where: { kind: WELCOME, status: { in: [RewardStatus.RESERVED, RewardStatus.REDEEMED] }, phoneHash, NOT: { id: reward.id } },
      select: { id: true },
    });
    if (clash) return null;
  }

  const { count } = await tx.referralReward.updateMany({
    where: { id: reward.id, status: RewardStatus.AVAILABLE, expiresAt: { gt: now } },
    data: { status: RewardStatus.RESERVED, ...refWhere(ref), reservedAt: now, discountMinor, phoneHash },
  });
  if (count === 0) return null;
  await tx.referralEvent.create({
    data: {
      referralId: reward.referralId,
      rewardId: reward.id,
      type: "reserved",
      data: { ...refWhere(ref), discountMinor, latePayment: true },
    },
  });
  return { rewardId: reward.id, status: RewardStatus.RESERVED };
};

/* ---------------------------------------------------- release / consume */

export type EndOutcome = "CANCELLED" | "EXPIRED_UNPAID" | "NO_SHOW";

/**
 * RESERVED → AVAILABLE (back in the customer's hands) when `restore` and the
 * reward has not run out, otherwise → EXPIRED. Either way it leaves the
 * booking (the CHECK `referral_rewards_one_booking` wants no booking id on
 * anything but RESERVED / REDEEMED). No reward on the booking = no-op.
 */
const releaseCore = async (tx: Prisma.TransactionClient, ref: BookingRef, outcome: EndOutcome, restore: boolean) => {
  const reward = await tx.referralReward.findFirst({
    where: { ...refWhere(ref), status: RewardStatus.RESERVED },
  });
  if (!reward) return null;

  const now = new Date();
  const back = restore && reward.expiresAt.getTime() > now.getTime();
  const { count } = await tx.referralReward.updateMany({
    where: { id: reward.id, status: RewardStatus.RESERVED },
    data: back
      ? { status: RewardStatus.AVAILABLE, ...DETACH }
      : { status: RewardStatus.EXPIRED, expiredReason: "TIME", ...DETACH },
  });
  if (count === 0) return null;

  const to = back ? RewardStatus.AVAILABLE : RewardStatus.EXPIRED;
  await tx.referralEvent.create({
    data: {
      referralId: reward.referralId,
      rewardId: reward.id,
      type: "released",
      data: { outcome, to, ...refWhere(ref), discountMinor: reward.discountMinor },
    },
  });
  return { rewardId: reward.id, status: to };
};

/** A cancel or an unpaid home expiry: back to AVAILABLE under `referral.restoreOnCancel`, else EXPIRED. */
export const releaseTx = async (
  tx: Prisma.TransactionClient,
  ref: BookingRef,
  outcome: "CANCELLED" | "EXPIRED_UNPAID",
) => releaseCore(tx, ref, outcome, (await loadReferralSettings()).restoreOnCancel);

/** RESERVED → REDEEMED + `redeemedAt`, with an event of `type`. */
const spendCore = async (tx: Prisma.TransactionClient, ref: BookingRef, type: string) => {
  const reward = await tx.referralReward.findFirst({
    where: { ...refWhere(ref), status: RewardStatus.RESERVED },
    select: { id: true, referralId: true, discountMinor: true },
  });
  if (!reward) return null;
  const { count } = await tx.referralReward.updateMany({
    where: { id: reward.id, status: RewardStatus.RESERVED },
    data: { status: RewardStatus.REDEEMED, redeemedAt: new Date() },
  });
  if (count === 0) return null;
  const ev = await tx.referralEvent.create({
    data: {
      referralId: reward.referralId,
      rewardId: reward.id,
      type,
      data: { ...refWhere(ref), discountMinor: reward.discountMinor },
    },
  });
  // A no-show using the reward up is not a redemption.
  if (type === "redeemed") {
    countAfterCommit(ev.id, [
      { metric: "rewards_redeemed", dimension: "appointmentId" in ref ? "booking:salon" : "booking:home" },
    ]);
  }
  return { rewardId: reward.id, status: RewardStatus.REDEEMED };
};

/** A customer no-show uses the reward up, unless `referral.restoreOnNoShow` (then as a release). */
export const consumeOnNoShowTx = async (tx: Prisma.TransactionClient, ref: BookingRef) => {
  const s = await loadReferralSettings();
  if (s.restoreOnNoShow) return releaseCore(tx, ref, "NO_SHOW", true);
  return spendCore(tx, ref, "consumed_no_show");
};

/** The visit was completed: the reserved reward is spent. */
export const redeemTx = (tx: Prisma.TransactionClient, ref: BookingRef) => spendCore(tx, ref, "redeemed");

/**
 * An upheld no-show appeal: a reward the no-show used up goes back to
 * AVAILABLE if it has not run out (EXPIRED if it has). For an appointment the
 * no-show must be overturned (appeal APPROVED; the status itself stays
 * NO_SHOW) or the status moved off NO_SHOW; anything else is left alone.
 */
export const restoreAfterAppealTx = async (tx: Prisma.TransactionClient, ref: BookingRef) => {
  if ("appointmentId" in ref) {
    const a = await tx.appointment.findUnique({
      where: { id: ref.appointmentId },
      select: { status: true, appealStatus: true },
    });
    if (!a || (a.status === AppointmentStatus.NO_SHOW && a.appealStatus !== AppealStatus.APPROVED)) return null;
  }

  const reward = await tx.referralReward.findFirst({
    where: { ...refWhere(ref), status: RewardStatus.REDEEMED },
  });
  if (!reward) return null;

  const back = reward.expiresAt.getTime() > Date.now();
  const { count } = await tx.referralReward.updateMany({
    where: { id: reward.id, status: RewardStatus.REDEEMED },
    data: back
      ? { status: RewardStatus.AVAILABLE, ...DETACH }
      : { status: RewardStatus.EXPIRED, expiredReason: "TIME", ...DETACH },
  });
  if (count === 0) return null;

  const to = back ? RewardStatus.AVAILABLE : RewardStatus.EXPIRED;
  await tx.referralEvent.create({
    data: {
      referralId: reward.referralId,
      rewardId: reward.id,
      type: "restored_after_appeal",
      data: { to, ...refWhere(ref), discountMinor: reward.discountMinor },
    },
  });
  return { rewardId: reward.id, status: to };
};

/* ---------------------------------------------------------------- notices */

/**
 * Runs `send` 1.5 s from now, outside the transaction that queued it, and only
 * if the reward committed in `expected` status (a rolled-back transaction
 * leaves no row, or a different one). The senders use
 * `dedupeKey = referral.<kind>:<rewardId>`, so a repeat is harmless.
 */
export const queueNotice = (rewardId: string, expected: RewardStatus, send: (rewardId: string) => Promise<unknown>) => {
  setTimeout(() => {
    void (async () => {
      try {
        const row = await prisma.referralReward.findUnique({ where: { id: rewardId }, select: { status: true } });
        if (row?.status === expected) await send(rewardId);
      } catch (err) {
        console.error("[referral] notice failed", err);
      }
    })();
  }, 1500);
};
