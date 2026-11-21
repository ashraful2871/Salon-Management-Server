-- Referral Phase 1, part 3. A home visit's total is its services less the
-- platform-funded promo plus travel; priceCart (home.money.ts) is the only
-- writer and already computes it that way. Kept out of
-- 20261119120100_referral_model because that one was already recorded as
-- applied on the VPS database (2026-11-20), so an edit there would never run.
-- Precondition checked 2026-11-21 on the VPS: 0 rows break it.

ALTER TABLE "home_bookings" ADD CONSTRAINT "home_bookings_total" CHECK (
  "totalMinor" = "subtotalMinor" - "promoDiscountMinor" + "travelFeeMinor");
