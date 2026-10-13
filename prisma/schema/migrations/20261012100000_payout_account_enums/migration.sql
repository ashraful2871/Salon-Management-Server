-- Owner Phase 3: payout account + KYC enums. In their own migration because a
-- new enum value cannot be used in the transaction that adds it.

ALTER TYPE "OtpPurpose" ADD VALUE IF NOT EXISTS 'PAYOUT_ACCOUNT';

DO $$ BEGIN
  CREATE TYPE "PayoutAccountType" AS ENUM ('BKASH', 'NAGAD', 'BANK');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PayoutAccountStatus" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'REJECTED', 'DISABLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "KycStatus" AS ENUM ('NONE', 'SUBMITTED', 'VERIFIED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
