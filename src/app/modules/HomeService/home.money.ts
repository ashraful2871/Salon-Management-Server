import { toMinor } from "../../utils/money";

/**
 * What a home visit costs, in poisha. `total = subtotal + travelFee`; the
 * advance is rounded up to whole taka and never exceeds the total; the
 * commission (subtotal only, never the travel fee) is snapshotted as bps.
 */

export type PriceSettings = {
  advancePercent: number;
  commissionPercent: number;
  /** The platform cap; a branch fee saved above a since-lowered cap is clamped. */
  travelFeeMaxMinor: number;
};

export type CartPrice = {
  subtotalMinor: number;
  travelFeeMinor: number;
  totalMinor: number;
  advancePercent: number;
  advanceMinor: number;
  balanceMinor: number;
  commissionBps: number;
};

export const priceCart = (
  items: Array<{ priceMinor: number }>,
  profile: { travelFeeMinor: number },
  settings: PriceSettings,
): CartPrice => {
  const subtotalMinor = items.reduce((s, i) => s + i.priceMinor, 0);
  const travelFeeMinor = Math.max(0, Math.min(profile.travelFeeMinor, settings.travelFeeMaxMinor));
  const totalMinor = subtotalMinor + travelFeeMinor;
  // Integer maths: total × percent is exact, then up to the next whole taka.
  const advanceMinor = Math.min(totalMinor, toMinor(Math.ceil((totalMinor * settings.advancePercent) / 10_000)));
  return {
    subtotalMinor,
    travelFeeMinor,
    totalMinor,
    advancePercent: settings.advancePercent,
    advanceMinor,
    balanceMinor: totalMinor - advanceMinor,
    commissionBps: Math.round(settings.commissionPercent * 100),
  };
};
