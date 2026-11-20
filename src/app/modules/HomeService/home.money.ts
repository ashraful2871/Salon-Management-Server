import { toMinor } from "../../utils/money";

/**
 * What a home visit costs, in poisha. `total = subtotal − promo + travelFee`,
 * where `promo` is a platform-funded referral discount clamped to the services
 * subtotal (it never touches the travel fee); the advance is taken on that
 * total, rounded up to whole taka and never more than it. The commission
 * (subtotal only, never the travel fee, never reduced by the promo) is
 * snapshotted as bps.
 */

export type PriceSettings = {
  advancePercent: number;
  commissionPercent: number;
  /** The platform cap; a branch fee saved above a since-lowered cap is clamped. */
  travelFeeMaxMinor: number;
};

export type CartPrice = {
  subtotalMinor: number;
  /** Referral discount taken off the subtotal (0 = none). */
  promoDiscountMinor: number;
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
  promoDiscountMinor = 0,
): CartPrice => {
  const subtotalMinor = items.reduce((s, i) => s + i.priceMinor, 0);
  const promo = Math.max(0, Math.min(Math.floor(promoDiscountMinor), subtotalMinor));
  const travelFeeMinor = Math.max(0, Math.min(profile.travelFeeMinor, settings.travelFeeMaxMinor));
  const totalMinor = subtotalMinor - promo + travelFeeMinor;
  // Integer maths: total × percent is exact, then up to the next whole taka.
  const advanceMinor = Math.min(totalMinor, toMinor(Math.ceil((totalMinor * settings.advancePercent) / 10_000)));
  return {
    subtotalMinor,
    promoDiscountMinor: promo,
    travelFeeMinor,
    totalMinor,
    advancePercent: settings.advancePercent,
    advanceMinor,
    balanceMinor: totalMinor - advanceMinor,
    commissionBps: Math.round(settings.commissionPercent * 100),
  };
};

/** Commission on a completed visit: the full subtotal (never the travel fee, never less the
 *  promo - the platform makes the salon whole for that), at the snapshot rate. */
export const homeCommissionMinor = (subtotalMinor: number, commissionBps: number) =>
  Math.round((subtotalMinor * commissionBps) / 10_000);
