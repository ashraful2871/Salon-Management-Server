import { AppealStatus, Prisma, RewardStatus } from "@prisma/client";
import prisma from "../../shared/prisma";
import { incrementMetrics } from "../Analytics/analytics.capture";
import { dhakaDay } from "../Analytics/analytics.days";
import { notifyExpiring } from "./referral.notify";
import {
  consumeOnNoShowTx,
  redeemTx,
  releaseTx,
  restoreAfterAppealTx,
  type BookingRef,
} from "./referral.rewards";
import { loadReferralSettings } from "./referral.settings";

/**
 * The referral jobs, registered in `jobs/scheduler.ts` (each run under its
 * advisory lock and recorded in `job_runs`):
 *
 *   referral.expire     hourly: lapsed rewards and referrals → EXPIRED
 *   referral.reminders  every 30 min, acting once a day from 10:00 Dhaka
 *   referral.reconcile  daily: RESERVED rewards on ended bookings fixed;
 *                       REDEEMED rewards that disagree with the ledger reported
 *
 * Every move is a conditional update (only rows still in the old status move)
 * with one `ReferralEvent` per row moved, in the same transaction.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 500;
const LIMIT_BATCH = Prisma.raw(String(BATCH));
/** A sign-up never verified lapses after this many days. */
const PENDING_VERIFICATION_DAYS = 14;
const REMIND_WITHIN_MS = 3 * DAY_MS;
const REMIND_HOUR_DHAKA = 10;
const REMIND_DAY_KEY = "referral.reminders.day";

/** A JS instant as the UTC `timestamp` the columns hold. */
const ts = (at: Date) => Prisma.sql`(${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
const NOW_UTC = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

// ---------------------------------------------------------------- expire

/** Rewards AVAILABLE / PENDING_REVIEW past `expiresAt` → EXPIRED (`TIME`), 500 at a time. */
const expireRewards = async (now: Date) => {
  let total = 0;
  for (;;) {
    const moved = await prisma.$transaction(async (tx) => {
      // SKIP LOCKED: a reward being reserved right now is left for next time.
      const rows = await tx.$queryRaw<Array<{ id: string; referralId: string | null; from: string }>>`
        WITH due AS (
          SELECT id, status::text AS from_status FROM referral_rewards
          WHERE status IN ('AVAILABLE', 'PENDING_REVIEW') AND "expiresAt" <= ${ts(now)}
          ORDER BY "expiresAt" LIMIT ${LIMIT_BATCH}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE referral_rewards r
        SET status = 'EXPIRED', "expiredReason" = 'TIME', "updatedAt" = ${NOW_UTC}
        FROM due
        WHERE r.id = due.id AND r.status IN ('AVAILABLE', 'PENDING_REVIEW')
        RETURNING r.id, r."referralId", due.from_status AS "from"`;
      if (rows.length) {
        await tx.referralEvent.createMany({
          data: rows.map((r) => ({
            referralId: r.referralId,
            rewardId: r.id,
            type: "expired",
            data: { reason: "TIME", from: r.from },
          })),
        });
      }
      return rows.length;
    });
    total += moved;
    if (moved < BATCH) return total;
  }
};

/** Referrals in `status` that match `due` (a SQL condition) → EXPIRED with `reason`, 500 at a time. */
const expireReferralsWhere = async (status: "JOINED" | "PENDING_VERIFICATION", due: Prisma.Sql, reason: string) => {
  let total = 0;
  for (;;) {
    const moved = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        WITH due AS (
          SELECT id FROM referrals
          WHERE status = ${status}::"ReferralStatus" AND ${due}
          ORDER BY "createdAt" LIMIT ${LIMIT_BATCH}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE referrals rf
        SET status = 'EXPIRED', "updatedAt" = ${NOW_UTC}
        FROM due
        WHERE rf.id = due.id AND rf.status = ${status}::"ReferralStatus"
        RETURNING rf.id`;
      if (rows.length) {
        await tx.referralEvent.createMany({
          data: rows.map((r) => ({ referralId: r.id, type: "expired", data: { reason, from: status } })),
        });
      }
      return rows.length;
    });
    total += moved;
    if (moved < BATCH) return total;
  }
};

/** Job `referral.expire`, hourly; safe to run by hand. */
export const runReferralExpire = async (now = new Date()) => {
  const s = await loadReferralSettings();
  const rewardsExpired = await expireRewards(now);
  // A friend who joined but never made a qualifying booking within the window.
  const joinedExpired = await expireReferralsWhere(
    "JOINED",
    Prisma.sql`"joinedAt" IS NOT NULL AND "joinedAt" <= ${ts(new Date(now.getTime() - s.qualifyWindowDays * DAY_MS))}`,
    "QUALIFY_WINDOW",
  );
  // A sign-up whose email was never verified.
  const pendingExpired = await expireReferralsWhere(
    "PENDING_VERIFICATION",
    Prisma.sql`"createdAt" <= ${ts(new Date(now.getTime() - PENDING_VERIFICATION_DAYS * DAY_MS))}`,
    "NOT_VERIFIED",
  );
  return { rewardsExpired, joinedExpired, pendingExpired };
};

// ---------------------------------------------------------------- reminders

/**
 * Job `referral.reminders`, every 30 min; acts once per Dhaka day on the first
 * run at or after 10:00 Dhaka (marked in `alert_states` before working, like
 * dues.watch). Each AVAILABLE reward running out within 3 days is claimed by
 * stamping `remindedAt` (a conditional update) and then reminded, so it is
 * never reminded twice.
 */
export const runReferralReminders = async (now = new Date()) => {
  const clockHour = new Date(now.getTime() + 6 * 60 * 60 * 1000).getUTCHours();
  if (clockHour < REMIND_HOUR_DHAKA) return { ran: false, reason: "before 10:00 Dhaka" };

  const today = dhakaDay(now);
  const state = await prisma.alertState.findUnique({ where: { key: REMIND_DAY_KEY } });
  if ((state?.detail as { day?: string } | null)?.day === today) {
    return { ran: false, reason: "already ran today", day: today };
  }
  await prisma.alertState.upsert({
    where: { key: REMIND_DAY_KEY },
    create: { key: REMIND_DAY_KEY, status: "OK", detail: { day: today } },
    update: { detail: { day: today }, lastNotifiedAt: new Date() },
  });

  const due = await prisma.referralReward.findMany({
    where: {
      status: RewardStatus.AVAILABLE,
      remindedAt: null,
      expiresAt: { gt: now, lte: new Date(now.getTime() + REMIND_WITHIN_MS) },
    },
    select: { id: true },
    orderBy: { expiresAt: "asc" },
    take: 2000,
  });

  let reminded = 0;
  for (const r of due) {
    const { count } = await prisma.referralReward.updateMany({
      where: { id: r.id, status: RewardStatus.AVAILABLE, remindedAt: null },
      data: { remindedAt: new Date() },
    });
    if (count === 0) continue;
    await notifyExpiring(r.id); // never throws
    reminded += 1;
  }
  return { ran: true, day: today, due: due.length, reminded };
};

// ---------------------------------------------------------------- reconcile

type Fix = "redeem" | "release" | "consume" | "consume+restore" | "skip";

/** What a RESERVED reward should become, given the booking it sits on. */
const fixFor = (
  ref: BookingRef,
  booking: { status: string; appealStatus: AppealStatus | null; noShowParty?: string | null } | undefined,
): { fix: Fix; outcome?: "CANCELLED" | "EXPIRED_UNPAID" } => {
  if (!booking) return { fix: "release", outcome: "CANCELLED" }; // the booking is gone
  switch (booking.status) {
    case "COMPLETED":
      return { fix: "redeem" };
    case "CANCELLED":
      return { fix: "release", outcome: "CANCELLED" };
    case "EXPIRED":
      return { fix: "release", outcome: "EXPIRED_UNPAID" };
    case "NO_SHOW": {
      // A home visit the expert missed gives the reward back, like a cancel.
      if ("homeBookingId" in ref && booking.noShowParty && booking.noShowParty !== "CUSTOMER") {
        return { fix: "release", outcome: "CANCELLED" };
      }
      return { fix: booking.appealStatus === AppealStatus.APPROVED ? "consume+restore" : "consume" };
    }
    default:
      return { fix: "skip" }; // still live: the reservation is right
  }
};

/**
 * REDEEMED rewards on a COMPLETED booking whose PLATFORM_PROMO lines do not
 * sum to −discountMinor (none written, or a different amount). Report only:
 * the ledger is never rewritten by a job.
 */
export const findPromoMismatches = () =>
  prisma.$queryRaw<Array<{ rewardId: string; discountMinor: number; promoMinor: number }>>`
    SELECT r.id AS "rewardId", r."discountMinor", COALESCE(SUM(l."amountMinor"), 0)::int AS "promoMinor"
    FROM referral_rewards r
    LEFT JOIN appointments a ON a.id = r."appointmentId"
    LEFT JOIN home_bookings h ON h.id = r."homeBookingId"
    LEFT JOIN ledger_entries l ON l.account = 'PLATFORM_PROMO'
      AND ((r."appointmentId" IS NOT NULL AND l."appointmentId" = r."appointmentId")
        OR (r."homeBookingId" IS NOT NULL AND l."homeBookingId" = r."homeBookingId"))
    WHERE r.status = 'REDEEMED' AND (a.status = 'COMPLETED' OR h.status = 'COMPLETED')
    GROUP BY r.id, r."discountMinor"
    HAVING COALESCE(SUM(l."amountMinor"), 0) <> -r."discountMinor"`;

/**
 * Job `referral.reconcile`, daily; safe to run by hand. The net under the
 * booking hooks: a RESERVED reward whose booking ended (or vanished) without
 * moving it gets the transition the hook would have made. Counts go in the
 * run summary; `redeemedMismatch > 0` raises the `referral.mismatch` alert in
 * system.watch.
 */
export const runReferralReconcile = async () => {
  const reserved = await prisma.referralReward.findMany({
    where: { status: RewardStatus.RESERVED },
    select: { id: true, appointmentId: true, homeBookingId: true },
  });
  const appointmentIds = reserved.map((r) => r.appointmentId).filter((x): x is string => !!x);
  const homeIds = reserved.map((r) => r.homeBookingId).filter((x): x is string => !!x);
  const [appointments, homes] = await Promise.all([
    appointmentIds.length
      ? prisma.appointment.findMany({
          where: { id: { in: appointmentIds } },
          select: { id: true, status: true, appealStatus: true },
        })
      : [],
    homeIds.length
      ? prisma.homeBooking.findMany({
          where: { id: { in: homeIds } },
          select: { id: true, status: true, appealStatus: true, noShowParty: true },
        })
      : [],
  ]);
  const apptById = new Map(appointments.map((a) => [a.id, a]));
  const homeById = new Map(homes.map((h) => [h.id, h]));

  const fixed: Record<string, number> = {};
  const failed: string[] = [];
  for (const r of reserved) {
    const ref: BookingRef | null = r.appointmentId
      ? { appointmentId: r.appointmentId }
      : r.homeBookingId
        ? { homeBookingId: r.homeBookingId }
        : null;
    if (!ref) continue; // CHECK referral_rewards_one_booking keeps this from happening
    const booking = "appointmentId" in ref ? apptById.get(ref.appointmentId) : homeById.get(ref.homeBookingId);
    const { fix, outcome } = fixFor(ref, booking);
    if (fix === "skip") continue;
    try {
      const done = await prisma.$transaction(async (tx) => {
        if (fix === "redeem") return redeemTx(tx, ref);
        if (fix === "release") return releaseTx(tx, ref, outcome ?? "CANCELLED");
        const spent = await consumeOnNoShowTx(tx, ref);
        if (fix === "consume+restore") await restoreAfterAppealTx(tx, ref);
        return spent;
      });
      if (done) {
        fixed[fix] = (fixed[fix] ?? 0) + 1;
        console.warn(`[jobs] referral.reconcile: reward ${r.id} was RESERVED on an ended booking → ${fix}`);
      }
    } catch (err) {
      failed.push(r.id);
      console.error(`[jobs] referral.reconcile: reward ${r.id} could not be fixed`, err);
    }
  }
  const fixedTotal = Object.values(fixed).reduce((a, b) => a + b, 0);

  const mismatches = await findPromoMismatches();
  if (mismatches.length) {
    console.error(
      `[jobs] referral.reconcile: ${mismatches.length} redeemed reward(s) disagree with the ledger`,
      mismatches.slice(0, 20),
    );
  }

  if (fixedTotal > 0) incrementMetrics([{ metric: "referral.reconciled", by: fixedTotal }]);
  // system.watch reads `redeemedMismatch` from this run's summary (alert referral.mismatch).
  return {
    reserved: reserved.length,
    fixed: fixedTotal,
    fixedBy: fixed,
    failed: failed.length,
    redeemedMismatch: mismatches.length,
    mismatchRewardIds: mismatches.slice(0, 20).map((m) => m.rewardId),
  };
};
