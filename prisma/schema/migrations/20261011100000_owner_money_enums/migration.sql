-- Owner Phase 2: money engine enum values. Additive only; in their own
-- migration because a new enum value cannot be used in the transaction that
-- adds it.

ALTER TYPE "PayoutStatus" ADD VALUE IF NOT EXISTS 'APPROVED';
ALTER TYPE "PayoutStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "LedgerAccount" ADD VALUE IF NOT EXISTS 'PLATFORM_CASH';
ALTER TYPE "IntentPurpose" ADD VALUE IF NOT EXISTS 'SALON_DUES';
