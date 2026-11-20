import prisma from "../../shared/prisma";
import { incrementMetrics } from "../Analytics/analytics.capture";

/**
 * The referral server metrics (`referral.*` in the metric dictionary), counted
 * live like `home.outOfArea`. Events are written inside booking and sign-up
 * transactions that can still roll back, so a count is taken 1.5 s later and
 * only if the event row committed; test referrals and test customers are not
 * counted. Fire and forget: never throws, never slows the caller.
 */

export type ReferralMetric = "attached" | "joined" | "qualified" | "rewards_issued" | "rewards_redeemed" | "flagged";

type Count = { metric: ReferralMetric; dimension?: string };

export const countAfterCommit = (eventId: string, counts: Count[]) => {
  if (!counts.length) return;
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const ev = await prisma.referralEvent.findUnique({
          where: { id: eventId },
          select: {
            referral: { select: { isTest: true } },
            reward: { select: { user: { select: { isTest: true } } } },
          },
        });
        if (!ev || ev.referral?.isTest || ev.reward?.user.isTest) return;
        incrementMetrics(
          counts.flatMap((c) => [
            { metric: `referral.${c.metric}` },
            ...(c.dimension ? [{ metric: `referral.${c.metric}`, dimension: c.dimension }] : []),
          ]),
        );
      } catch (err) {
        console.error("[referral] metric count failed", err);
      }
    })();
  }, 1500);
  timer.unref?.();
};

/** `kind:referee_welcome` and the like. */
export const kindDim = (kind: string) => `kind:${kind.toLowerCase()}`;
