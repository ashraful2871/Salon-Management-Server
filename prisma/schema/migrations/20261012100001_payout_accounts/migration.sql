-- Owner Phase 3: where a business is paid, and its KYC. Additive only.

ALTER TABLE "salon_owners"
  ADD COLUMN IF NOT EXISTS "legalName" TEXT,
  ADD COLUMN IF NOT EXISTS "tradeLicenseNo" TEXT,
  ADD COLUMN IF NOT EXISTS "tin" TEXT,
  ADD COLUMN IF NOT EXISTS "bin" TEXT,
  ADD COLUMN IF NOT EXISTS "nidLast4" TEXT,
  ADD COLUMN IF NOT EXISTS "kycStatus" "KycStatus" NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS "kycNote" TEXT,
  ADD COLUMN IF NOT EXISTS "payoutsFrozen" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "payout_accounts" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "type" "PayoutAccountType" NOT NULL,
  "accountName" TEXT NOT NULL,
  "walletNumber" TEXT,
  "bankName" TEXT,
  "branchName" TEXT,
  "routingNumber" TEXT,
  "accountNumberEnc" TEXT,
  "last4" TEXT NOT NULL,
  "status" "PayoutAccountStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
  "verifiedById" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "rejectionReason" TEXT,
  "cooldownUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payout_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payout_accounts_ownerId_fkey" FOREIGN KEY ("ownerId")
    REFERENCES "salon_owners"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "payout_accounts_ownerId_status_idx" ON "payout_accounts"("ownerId", "status");
CREATE INDEX IF NOT EXISTS "payout_accounts_status_createdAt_idx" ON "payout_accounts"("status", "createdAt");

-- At most one pending account per business: a new one replaces the older
-- pending row in the same transaction, and this makes a race lose with 409.
CREATE UNIQUE INDEX IF NOT EXISTS "payout_accounts_one_pending"
  ON "payout_accounts"("ownerId") WHERE "status" = 'PENDING_VERIFICATION';
