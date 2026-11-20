-- Referral Phase 1, part 1 of 2.
-- Postgres refuses to use an enum value in the transaction that added it, so
-- PLATFORM_PROMO gets its own migration, applied before 20261119120100_referral_model.

-- AlterEnum
ALTER TYPE "LedgerAccount" ADD VALUE 'PLATFORM_PROMO';
