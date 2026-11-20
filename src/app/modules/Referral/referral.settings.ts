import { getSetting } from "../../utils/settings";
import { percentToBps, type Scope } from "./referral.math";

/**
 * Every referral setting in one read (registry: `utils/settings.ts`, group
 * `referral` + the two kill switches in `flags`). Values come through the
 * registry's 30 s cache, so a call is cheap; read it once per request and pass
 * the object down rather than calling `getSetting` key by key.
 *
 * Percents are also given in basis points (`…PercentBps`), the unit rewards
 * snapshot and `referral.math.ts` computes with.
 */
export type ReferralSettings = {
  enabled: boolean;
  redemptionsEnabled: boolean;
  refereePercent: number;
  refereePercentBps: number;
  refereeMaxDiscountMinor: number;
  refereeValidDays: number;
  refereeScope: Scope;
  referrerPercent: number;
  referrerPercentBps: number;
  referrerMaxDiscountMinor: number;
  referrerValidDays: number;
  referrerScope: Scope;
  referrerTrigger: "FIRST_BOOKING_COMPLETED" | "REFEREE_VERIFIED";
  minOrderMinor: number;
  qualifyWindowDays: number;
  /** 0 = no cap. */
  maxRewardsPerMonth: number;
  /** 0 = no cap. */
  maxRewardsLifetime: number;
  attributionDays: number;
  restoreOnCancel: boolean;
  restoreOnNoShow: boolean;
  holdFlagged: boolean;
  velocityPerDay: number;
  shareMessage: string;
};

export const loadReferralSettings = async (): Promise<ReferralSettings> => {
  const [
    enabled,
    redemptionsEnabled,
    refereePercent,
    refereeMaxDiscountMinor,
    refereeValidDays,
    refereeScope,
    referrerPercent,
    referrerMaxDiscountMinor,
    referrerValidDays,
    referrerScope,
    referrerTrigger,
    minOrderMinor,
    qualifyWindowDays,
    maxRewardsPerMonth,
    maxRewardsLifetime,
    attributionDays,
    restoreOnCancel,
    restoreOnNoShow,
    holdFlagged,
    velocityPerDay,
    shareMessage,
  ] = await Promise.all([
    getSetting("referral.enabled"),
    getSetting("referral.redemptionsEnabled"),
    getSetting("referral.refereePercent"),
    getSetting("referral.refereeMaxDiscountMinor"),
    getSetting("referral.refereeValidDays"),
    getSetting("referral.refereeScope"),
    getSetting("referral.referrerPercent"),
    getSetting("referral.referrerMaxDiscountMinor"),
    getSetting("referral.referrerValidDays"),
    getSetting("referral.referrerScope"),
    getSetting("referral.referrerTrigger"),
    getSetting("referral.minOrderMinor"),
    getSetting("referral.qualifyWindowDays"),
    getSetting("referral.maxRewardsPerMonth"),
    getSetting("referral.maxRewardsLifetime"),
    getSetting("referral.attributionDays"),
    getSetting("referral.restoreOnCancel"),
    getSetting("referral.restoreOnNoShow"),
    getSetting("referral.holdFlagged"),
    getSetting("referral.velocityPerDay"),
    getSetting("referral.shareMessage"),
  ]);

  return {
    enabled,
    redemptionsEnabled,
    refereePercent,
    refereePercentBps: percentToBps(refereePercent),
    refereeMaxDiscountMinor,
    refereeValidDays,
    refereeScope,
    referrerPercent,
    referrerPercentBps: percentToBps(referrerPercent),
    referrerMaxDiscountMinor,
    referrerValidDays,
    referrerScope,
    referrerTrigger,
    minOrderMinor,
    qualifyWindowDays,
    maxRewardsPerMonth,
    maxRewardsLifetime,
    attributionDays,
    restoreOnCancel,
    restoreOnNoShow,
    holdFlagged,
    velocityPerDay,
    shareMessage,
  };
};
