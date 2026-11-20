import { AppointmentStatus, Prisma, RewardStatus } from "@prisma/client";
import { monthStartDhaka } from "./referral.math";
import { notifyEarned, notifyHeld } from "./referral.notify";
import {
  consumeOnNoShowTx,
  queueNotice,
  redeemTx,
  releaseTx,
  type BookingRef,
} from "./referral.rewards";
import { loadReferralSettings } from "./referral.settings";
import { countAfterCommit, kindDim } from "./referral.metrics";

/**
 * The only entry points booking code calls at the end of a booking (salon
 * appointments now, home visits in Phase 5). Each runs inside the booking's
 * own transaction, so a rolled-back completion or cancel moves no reward.
 */

export type CompletedBooking = {
  kind: "SALON" | "HOME";
  id: string;
  customerId: string;
  source: "PLATFORM" | "SALON_DIRECT";
  /** Salon: `billableMinor(appointment)` (total − counter discount). Home: the subtotal. */
  billableMinor: number;
  /** Null when the stale job closed it (→ `AUTO_CLOSED`). */
  completedById: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const refOf = (b: Pick<CompletedBooking, "kind" | "id">): BookingRef =>
  b.kind === "SALON" ? { appointmentId: b.id } : { homeBookingId: b.id };

/**
 * A completed booking: its reward is spent, the customer's first-booking-only
 * rewards lapse (they now have a completed booking), and the referral they
 * joined through may qualify.
 */
export const onBookingCompletedTx = async (tx: Prisma.TransactionClient, b: CompletedBooking) => {
  await redeemTx(tx, refOf(b));

  const lapsing = await tx.referralReward.findMany({
    where: { userId: b.customerId, status: RewardStatus.AVAILABLE, firstBookingOnly: true },
    select: { id: true, referralId: true },
  });
  if (lapsing.length > 0) {
    const { count } = await tx.referralReward.updateMany({
      where: { id: { in: lapsing.map((r) => r.id) }, status: RewardStatus.AVAILABLE },
      data: { status: RewardStatus.EXPIRED, expiredReason: "FIRST_BOOKING_DONE" },
    });
    if (count > 0) {
      await tx.referralEvent.createMany({
        data: lapsing.map((r) => ({
          referralId: r.referralId,
          rewardId: r.id,
          type: "expired",
          data: { reason: "FIRST_BOOKING_DONE", ...refOf(b) },
        })),
      });
    }
  }

  await qualifyTx(tx, b.customerId, b);
};

/** A booking that ended without being completed. */
export const onBookingEndedTx = (
  tx: Prisma.TransactionClient,
  ref: BookingRef,
  outcome: "CANCELLED" | "NO_SHOW" | "EXPIRED_UNPAID",
) => (outcome === "NO_SHOW" ? consumeOnNoShowTx(tx, ref) : releaseTx(tx, ref, outcome));

export type QualifyResult =
  | { qualified: false }
  | { qualified: true; rewardId: string | null; status: RewardStatus | null; skip: string | null };

/**
 * JOINED → QUALIFIED and the referrer's reward. With a booking (`b`), only the
 * referee's first COMPLETED booking qualifies, made on the platform, at least
 * `minOrderMinor`, within `qualifyWindowDays` of joining, and only under
 * `referrerTrigger = FIRST_BOOKING_COMPLETED`. With `b = null` (the
 * `REFEREE_VERIFIED` trigger, at email verification) no booking is needed.
 *
 * Any risk flag (sign-up flags, `PHONE_REUSED`, `AUTO_CLOSED`) holds the
 * reward in PENDING_REVIEW when `holdFlagged` is on. An ineligible referrer or
 * a monthly / lifetime cap still qualifies the referral, with no reward and the
 * reason in `referrerRewardSkip`. Notices go out after commit.
 */
export const qualifyTx = async (
  tx: Prisma.TransactionClient,
  refereeId: string,
  b: CompletedBooking | null,
): Promise<QualifyResult> => {
  const referral = await tx.referral.findUnique({ where: { refereeId } });
  if (!referral || referral.status !== "JOINED") return { qualified: false };

  const s = await loadReferralSettings();
  const now = new Date();

  if (b) {
    if (s.referrerTrigger !== "FIRST_BOOKING_COMPLETED") return { qualified: false };
    if (b.source !== "PLATFORM") return { qualified: false };
    if (b.billableMinor < s.minOrderMinor) return { qualified: false };
    if (!referral.joinedAt || now.getTime() - referral.joinedAt.getTime() > s.qualifyWindowDays * DAY_MS) {
      return { qualified: false };
    }
    const completed =
      (await tx.appointment.count({ where: { customerId: refereeId, status: AppointmentStatus.COMPLETED } })) +
      (await tx.homeBooking.count({ where: { customerId: refereeId, status: "COMPLETED" } }));
    if (completed !== 1) return { qualified: false };
  } else if (s.referrerTrigger !== "REFEREE_VERIFIED") {
    return { qualified: false };
  }

  const flags = Array.from(
    new Set([...referral.riskFlags, ...(b && b.completedById === null ? ["AUTO_CLOSED"] : [])]),
  );

  // One referrer at a time, so two friends qualifying together cannot both
  // slip under the cap.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`referral-cap:${referral.referrerId}`}::text, 0))`;

  const referrer = await tx.user.findUnique({
    where: { id: referral.referrerId },
    select: { role: true, status: true, isDeleted: true, referralCode: { select: { blockedAt: true } } },
  });
  let skip: string | null = null;
  if (
    !referrer ||
    referrer.role !== "CUSTOMER" ||
    referrer.status !== "ACTIVE" ||
    referrer.isDeleted ||
    referrer.referralCode?.blockedAt
  ) {
    skip = "REFERRER_INELIGIBLE";
  } else {
    // Counted like `/referrals/me` `stats.thisMonth`: REFERRER_BONUS not
    // REVOKED, since the 1st in Asia/Dhaka.
    const notRevoked = { userId: referral.referrerId, kind: "REFERRER_BONUS" as const, status: { not: RewardStatus.REVOKED } };
    if (s.maxRewardsPerMonth > 0) {
      const month = await tx.referralReward.count({ where: { ...notRevoked, createdAt: { gte: monthStartDhaka(now) } } });
      if (month >= s.maxRewardsPerMonth) skip = "CAP_MONTH";
    }
    if (!skip && s.maxRewardsLifetime > 0) {
      const lifetime = await tx.referralReward.count({ where: notRevoked });
      if (lifetime >= s.maxRewardsLifetime) skip = "CAP_LIFETIME";
    }
  }

  const moved = await tx.referral.updateMany({
    where: { id: referral.id, status: "JOINED" },
    data: {
      status: "QUALIFIED",
      qualifiedAt: now,
      riskFlags: flags,
      referrerRewardSkip: skip,
      ...(b?.kind === "SALON" ? { qualifyingAppointmentId: b.id } : {}),
      ...(b?.kind === "HOME" ? { qualifyingHomeBookingId: b.id } : {}),
    },
  });
  if (moved.count === 0) return { qualified: false }; // a parallel completion got here first

  const qualified = await tx.referralEvent.create({
    data: {
      referralId: referral.id,
      type: "qualified",
      data: { ...(b ? { kind: b.kind, bookingId: b.id, billableMinor: b.billableMinor } : { trigger: "REFEREE_VERIFIED" }), flags },
    },
  });

  countAfterCommit(qualified.id, [{ metric: "qualified", dimension: `booking:${b ? b.kind.toLowerCase() : "none"}` }]);

  if (skip) {
    await tx.referralEvent.create({ data: { referralId: referral.id, type: "referrer.skipped", data: { reason: skip } } });
    return { qualified: true, rewardId: null, status: null, skip };
  }

  const held = flags.length > 0 && s.holdFlagged;
  const status = held ? RewardStatus.PENDING_REVIEW : RewardStatus.AVAILABLE;
  const { count } = await tx.referralReward.createMany({
    data: [
      {
        userId: referral.referrerId,
        referralId: referral.id,
        kind: "REFERRER_BONUS",
        status,
        percentBps: s.referrerPercentBps,
        maxDiscountMinor: s.referrerMaxDiscountMinor,
        minOrderMinor: s.minOrderMinor,
        scope: s.referrerScope,
        firstBookingOnly: false,
        expiresAt: new Date(now.getTime() + s.referrerValidDays * DAY_MS),
      },
    ],
    skipDuplicates: true,
  });
  const reward = await tx.referralReward.findUniqueOrThrow({
    where: { referralId_kind: { referralId: referral.id, kind: "REFERRER_BONUS" } },
  });
  if (count === 0) return { qualified: true, rewardId: reward.id, status: reward.status, skip: null };

  const issued = await tx.referralEvent.create({
    data: {
      referralId: referral.id,
      rewardId: reward.id,
      type: "referrer.issued",
      data: {
        status,
        percentBps: reward.percentBps,
        maxDiscountMinor: reward.maxDiscountMinor,
        minOrderMinor: reward.minOrderMinor,
        scope: reward.scope,
        expiresAt: reward.expiresAt.toISOString(),
      },
    },
  });
  countAfterCommit(issued.id, [{ metric: "rewards_issued", dimension: kindDim("REFERRER_BONUS") }]);
  if (held) {
    const flagged = await tx.referralEvent.create({
      data: { referralId: referral.id, rewardId: reward.id, type: "flagged", data: { flags, held: true } },
    });
    countAfterCommit(
      flagged.id,
      flags.map((f) => ({ metric: "flagged" as const, dimension: `flag:${f.toLowerCase()}` })),
    );
  }

  queueNotice(reward.id, status, held ? notifyHeld : notifyEarned);
  return { qualified: true, rewardId: reward.id, status, skip: null };
};
