import config from "../../../config";
import prisma from "../../shared/prisma";
import { SITE_NAME } from "../../utils/brand";
import {
  getReferralEarnedTemplate,
  getReferralExpiringTemplate,
  getReferralWelcomeTemplate,
} from "../../utils/emailTemplates";
import { formatBDT } from "../../utils/money";
import { notify } from "../../utils/notify";
import { getSetting } from "../../utils/settings";
import { friendName } from "./referral.math";

/**
 * Every referral bell row and email. Each figure comes from the reward's own
 * snapshot (percent, cap, minimum, scope, expiry), never from current
 * settings - except "joined", which is sent before any reward exists. None of
 * these throw: `notify` swallows its own errors and the reads here are guarded.
 */

const REWARDS_PATH = "/dashboard/referrals";
const BOOK_PATH = "/salons";

const pct = (bps: number) => String(Math.round(bps) / 100);

const dhakaDate = (d: Date) =>
  d.toLocaleDateString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric" });

const SCOPE_TEXT = { ALL: "salon and home bookings", SALON: "salon bookings", HOME: "home visits" } as const;

type RewardRow = {
  id: string;
  userId: string;
  percentBps: number;
  maxDiscountMinor: number;
  minOrderMinor: number;
  scope: keyof typeof SCOPE_TEXT;
  expiresAt: Date;
};

const termsOf = (r: RewardRow) => ({
  percent: pct(r.percentBps),
  cap: r.maxDiscountMinor > 0 ? formatBDT(r.maxDiscountMinor) : null,
  minOrder: r.minOrderMinor > 0 ? formatBDT(r.minOrderMinor) : null,
  scopeText: SCOPE_TEXT[r.scope],
  expiresOn: dhakaDate(r.expiresAt),
});

/** ", up to ৳300" or "". */
const upTo = (r: RewardRow) => (r.maxDiscountMinor > 0 ? `, up to ${formatBDT(r.maxDiscountMinor)}` : "");

const loadReward = (rewardId: string) =>
  prisma.referralReward.findUnique({
    where: { id: rewardId },
    include: {
      referral: {
        select: {
          id: true,
          qualifyingAppointmentId: true,
          qualifyingHomeBookingId: true,
          referee: { select: { name: true } },
          referrer: { select: { name: true } },
        },
      },
    },
  });

const guarded = async (what: string, fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (err) {
    console.error(`[referral.notify] ${what} failed`, err);
  }
};

/** To the friend who signed up, once their welcome reward is issued. */
export const notifyWelcome = (refereeId: string) =>
  guarded("welcome", async () => {
    const reward = await prisma.referralReward.findFirst({
      where: { userId: refereeId, kind: "REFEREE_WELCOME" },
      orderBy: { createdAt: "desc" },
      include: { referral: { select: { referrer: { select: { name: true } } } } },
    });
    if (!reward) return;
    const p = pct(reward.percentBps);
    const by = dhakaDate(reward.expiresAt);
    const inviter = reward.referral?.referrer.name ? friendName(reward.referral.referrer.name) : null;
    await notify([refereeId], "referral.welcome", {
      title: `Your ${p}% welcome reward is ready`,
      body: `Get ${p}% off your first booking on ${SITE_NAME}${upTo(reward)}. Use it by ${by}; it is applied for you when you book.`,
      link: BOOK_PATH,
      dedupeKey: `referral.welcome:${reward.id}`,
      email: {
        subject: `Your ${p}% welcome reward is ready - ${SITE_NAME}`,
        html: (name) =>
          getReferralWelcomeTemplate({
            name,
            friendName: inviter,
            ...termsOf(reward),
            ctaUrl: `${config.frontend_url}${BOOK_PATH}`,
          }),
      },
    });
  });

/**
 * To the referrer when a friend's email is verified. No reward exists yet, so
 * the percent is today's `referral.referrerPercent`; with the
 * REFEREE_VERIFIED trigger the reward itself follows as `reward_earned`.
 */
export const notifyJoined = (referrerId: string, friend: string, referralId?: string) =>
  guarded("joined", async () => {
    const [percent, trigger] = await Promise.all([
      getSetting("referral.referrerPercent"),
      getSetting("referral.referrerTrigger"),
    ]);
    await notify([referrerId], "referral.joined", {
      title: `${friend} joined with your code`,
      body:
        trigger === "FIRST_BOOKING_COMPLETED"
          ? `${friend} joined ${SITE_NAME} with your code. You'll earn ${pct(percent * 100)}% off when they complete their first booking.`
          : `${friend} joined ${SITE_NAME} with your code.`,
      link: REWARDS_PATH,
      dedupeKey: referralId ? `referral.joined:${referralId}` : null,
    });
  });

/** To the referrer when their reward is issued (AVAILABLE). Used by Phase 4. */
export const notifyEarned = (rewardId: string) =>
  guarded("reward_earned", async () => {
    const reward = await loadReward(rewardId);
    if (!reward) return;
    const p = pct(reward.percentBps);
    const friend = friendName(reward.referral?.referee.name ?? "");
    const booked = !!(reward.referral?.qualifyingAppointmentId || reward.referral?.qualifyingHomeBookingId);
    await notify([reward.userId], "referral.reward_earned", {
      title: `You earned a ${p}% reward`,
      body: `${friend} ${booked ? "completed their first booking" : "joined with your code"}. Get ${p}% off a booking${upTo(reward)}. Use it by ${dhakaDate(reward.expiresAt)}.`,
      link: REWARDS_PATH,
      dedupeKey: `referral.reward_earned:${reward.id}`,
      email: {
        subject: `You earned a ${p}% reward - ${SITE_NAME}`,
        html: (name) =>
          getReferralEarnedTemplate({
            name,
            friendName: friend,
            ...termsOf(reward),
            ctaUrl: `${config.frontend_url}${REWARDS_PATH}`,
          }),
      },
    });
  });

/** To the referrer when their reward is held for review (PENDING_REVIEW). Used by Phase 4. */
export const notifyHeld = (rewardId: string) =>
  guarded("reward_held", async () => {
    const reward = await loadReward(rewardId);
    if (!reward) return;
    const friend = friendName(reward.referral?.referee.name ?? "");
    await notify([reward.userId], "referral.reward_held", {
      title: "Your referral reward is being checked",
      body: `${friend} completed their first booking. We're checking it before your ${pct(reward.percentBps)}% reward is released, and we'll let you know.`,
      link: REWARDS_PATH,
      dedupeKey: `referral.reward_held:${reward.id}`,
    });
  });

/** A few days before an unused reward runs out. Used by the Phase 6 job. */
export const notifyExpiring = (rewardId: string) =>
  guarded("reward_expiring", async () => {
    const reward = await loadReward(rewardId);
    if (!reward || reward.status !== "AVAILABLE") return;
    const p = pct(reward.percentBps);
    const by = dhakaDate(reward.expiresAt);
    await notify([reward.userId], "referral.reward_expiring", {
      title: `Your ${p}% reward expires on ${by}`,
      body: `Book before ${by} to get ${p}% off${upTo(reward)}. It is applied for you when you book.`,
      link: BOOK_PATH,
      dedupeKey: `referral.reward_expiring:${reward.id}`,
      email: {
        subject: `Your ${p}% reward expires on ${by} - ${SITE_NAME}`,
        html: (name) =>
          getReferralExpiringTemplate({ name, ...termsOf(reward), ctaUrl: `${config.frontend_url}${BOOK_PATH}` }),
      },
    });
  });

/** When an admin revokes a reward (Phase 6). The admin's reason is internal and not repeated here. */
export const notifyRevoked = (rewardId: string) =>
  guarded("reward_revoked", async () => {
    const reward = await loadReward(rewardId);
    if (!reward) return;
    await notify([reward.userId], "referral.reward_revoked", {
      title: `Your ${pct(reward.percentBps)}% reward was withdrawn`,
      body: `This reward can no longer be used. If you think this is a mistake, contact ${SITE_NAME} support.`,
      link: REWARDS_PATH,
      dedupeKey: `referral.reward_revoked:${reward.id}`,
    });
  });
