-- Wallet, deposits, settlement, and the move of every money column to integer
-- poisha. Written by hand rather than generated so the existing Float amounts
-- are carried across instead of dropped.

-- ---------------------------------------------------------------------------
-- 1. Money -> integer poisha (1 taka = 100 poisha)
-- ---------------------------------------------------------------------------
ALTER TABLE "services" ADD COLUMN "priceMinor" INTEGER;
UPDATE "services" SET "priceMinor" = ROUND("price" * 100)::INTEGER;
ALTER TABLE "services" ALTER COLUMN "priceMinor" SET NOT NULL;
ALTER TABLE "services" DROP COLUMN "price";

ALTER TABLE "payments" ADD COLUMN "amountMinor" INTEGER;
UPDATE "payments" SET "amountMinor" = ROUND("amount" * 100)::INTEGER;
ALTER TABLE "payments" ALTER COLUMN "amountMinor" SET NOT NULL;
ALTER TABLE "payments" DROP COLUMN "amount";

-- ---------------------------------------------------------------------------
-- 2. Enums
-- ---------------------------------------------------------------------------
CREATE TYPE "WalletTxType" AS ENUM ('TOPUP', 'TOPUP_REVERSAL', 'DEPOSIT_HOLD', 'DEPOSIT_RELEASE', 'DEPOSIT_APPLIED', 'DEPOSIT_FORFEIT', 'REFUND', 'CASHBACK', 'GOODWILL_CREDIT', 'ADJUSTMENT', 'WITHDRAWAL');
CREATE TYPE "IntentPurpose" AS ENUM ('WALLET_TOPUP', 'BOOKING');
CREATE TYPE "IntentStatus" AS ENUM ('INITIATED', 'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "DepositStatus" AS ENUM ('NONE', 'HELD', 'RELEASED', 'APPLIED', 'FORFEITED');
CREATE TYPE "AppealStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "AppointmentSource" AS ENUM ('PLATFORM', 'SALON_DIRECT');
CREATE TYPE "LedgerAccount" AS ENUM ('SALON_PAYABLE', 'PLATFORM_REVENUE', 'CUSTOMER_WALLET', 'GATEWAY_CLEARING');
CREATE TYPE "CommissionScope" AS ENUM ('NEW_CUSTOMER', 'OFF_PEAK', 'ALL');
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'PAID', 'FAILED');

-- ---------------------------------------------------------------------------
-- 3. Deposit policy on salons
-- ---------------------------------------------------------------------------
ALTER TABLE "salons"
  ADD COLUMN "depositMinor" INTEGER NOT NULL DEFAULT 3000,
  ADD COLUMN "depositPercent" INTEGER,
  ADD COLUMN "cancellationWindowMin" INTEGER NOT NULL DEFAULT 120,
  ADD COLUMN "noShowSalonSharePct" INTEGER NOT NULL DEFAULT 70;

-- ---------------------------------------------------------------------------
-- 4. Money and deposit state on appointments
-- ---------------------------------------------------------------------------
ALTER TABLE "appointments"
  ADD COLUMN "totalMinor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "depositMinor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "depositStatus" "DepositStatus" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "source" "AppointmentSource" NOT NULL DEFAULT 'PLATFORM',
  ADD COLUMN "noShowMarkedAt" TIMESTAMP(3),
  ADD COLUMN "appealedAt" TIMESTAMP(3),
  ADD COLUMN "appealReason" TEXT,
  ADD COLUMN "appealStatus" "AppealStatus";

CREATE INDEX "appointments_salonId_status_idx" ON "appointments"("salonId", "status");
CREATE INDEX "appointments_customerId_salonId_idx" ON "appointments"("customerId", "salonId");

-- ---------------------------------------------------------------------------
-- 5. Wallets and the append-only ledger
-- ---------------------------------------------------------------------------
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "heldBalance" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "isFrozen" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wallets_userId_key" ON "wallets"("userId");

ALTER TABLE "wallets" ADD CONSTRAINT "wallets_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "wallet_transactions" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "type" "WalletTxType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "heldAfter" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "idempotencyKey" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wallet_transactions_idempotencyKey_key" ON "wallet_transactions"("idempotencyKey");
CREATE INDEX "wallet_transactions_walletId_createdAt_idx" ON "wallet_transactions"("walletId", "createdAt");
CREATE INDEX "wallet_transactions_referenceType_referenceId_idx" ON "wallet_transactions"("referenceType", "referenceId");

ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_walletId_fkey"
  FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The guard application code cannot bypass. A balance must never go negative,
-- and money that is held must actually exist in the balance behind it.
ALTER TABLE "wallets" ADD CONSTRAINT "wallet_balance_non_negative" CHECK ("balance" >= 0);
ALTER TABLE "wallets" ADD CONSTRAINT "wallet_held_non_negative" CHECK ("heldBalance" >= 0);
ALTER TABLE "wallets" ADD CONSTRAINT "wallet_held_lte_balance" CHECK ("heldBalance" <= "balance");

-- ---------------------------------------------------------------------------
-- 6. Payment intents
-- ---------------------------------------------------------------------------
CREATE TABLE "payment_intents" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "IntentPurpose" NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "status" "IntentStatus" NOT NULL DEFAULT 'INITIATED',
    "provider" TEXT NOT NULL DEFAULT 'SSLCOMMERZ',
    "gatewayRef" TEXT,
    "method" TEXT,
    "sessionKey" TEXT,
    "rawResponse" JSONB,
    "referenceId" TEXT,
    "failureReason" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_intents_transactionId_key" ON "payment_intents"("transactionId");
CREATE INDEX "payment_intents_userId_createdAt_idx" ON "payment_intents"("userId", "createdAt");
CREATE INDEX "payment_intents_status_createdAt_idx" ON "payment_intents"("status", "createdAt");

ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 7. Settlement: commission rules, ledger, payouts
-- ---------------------------------------------------------------------------
CREATE TABLE "commission_rules" (
    "id" TEXT NOT NULL,
    "salonId" TEXT,
    "minAmountMinor" INTEGER NOT NULL DEFAULT 0,
    "maxAmountMinor" INTEGER,
    "flatFeeMinor" INTEGER,
    "percentBps" INTEGER,
    "appliesTo" "CommissionScope" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commission_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "commission_rules_salonId_isActive_idx" ON "commission_rules"("salonId", "isActive");

ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_salonId_fkey"
  FOREIGN KEY ("salonId") REFERENCES "salons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "payouts" (
    "id" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "grossMinor" INTEGER NOT NULL,
    "commissionMinor" INTEGER NOT NULL,
    "netMinor" INTEGER NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "method" TEXT,
    "reference" TEXT,
    "failureReason" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payouts_salonId_status_idx" ON "payouts"("salonId", "status");
CREATE INDEX "payouts_status_createdAt_idx" ON "payouts"("status", "createdAt");

ALTER TABLE "payouts" ADD CONSTRAINT "payouts_salonId_fkey"
  FOREIGN KEY ("salonId") REFERENCES "salons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT,
    "salonId" TEXT,
    "account" "LedgerAccount" NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "payoutId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ledger_entries_salonId_createdAt_idx" ON "ledger_entries"("salonId", "createdAt");
CREATE INDEX "ledger_entries_payoutId_idx" ON "ledger_entries"("payoutId");
CREATE INDEX "ledger_entries_appointmentId_idx" ON "ledger_entries"("appointmentId");

ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_appointmentId_fkey"
  FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_salonId_fkey"
  FOREIGN KEY ("salonId") REFERENCES "salons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payoutId_fkey"
  FOREIGN KEY ("payoutId") REFERENCES "payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
