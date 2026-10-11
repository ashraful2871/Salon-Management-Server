-- Owner Phase 2: journals and per-business payouts. Additive only, no DROP.

-- ---------------------------------------------------------------- ledger_entries
ALTER TABLE "ledger_entries" ADD COLUMN "journalId" TEXT;
ALTER TABLE "ledger_entries" ADD COLUMN "ownerId" TEXT;

-- Every set written so far was one per appointment, so the appointment is the
-- journal. A row with no appointment is its own journal.
UPDATE "ledger_entries" SET "journalId" = COALESCE("appointmentId", "id") WHERE "journalId" IS NULL;

UPDATE "ledger_entries" l
SET "ownerId" = s."ownerId"
FROM "salons" s
WHERE l."salonId" = s."id" AND l."ownerId" IS NULL;

ALTER TABLE "ledger_entries" ALTER COLUMN "journalId" SET NOT NULL;

CREATE INDEX "ledger_entries_journalId_idx" ON "ledger_entries"("journalId");
CREATE INDEX "ledger_entries_ownerId_createdAt_idx" ON "ledger_entries"("ownerId", "createdAt");
CREATE INDEX "ledger_entries_account_payoutId_createdAt_idx" ON "ledger_entries"("account", "payoutId", "createdAt");

-- ---------------------------------------------------------------- payouts
ALTER TABLE "payouts" ADD COLUMN "ownerId" TEXT;
ALTER TABLE "payouts" ADD COLUMN "approvedById" TEXT;
ALTER TABLE "payouts" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "payouts" ADD COLUMN "payoutAccountId" TEXT;
ALTER TABLE "payouts" ADD COLUMN "destinationSnapshot" JSONB;
ALTER TABLE "payouts" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "payouts" ADD COLUMN "cancelledReason" TEXT;

UPDATE "payouts" p
SET "ownerId" = s."ownerId"
FROM "salons" s
WHERE p."salonId" = s."id" AND p."ownerId" IS NULL;

ALTER TABLE "payouts" ALTER COLUMN "ownerId" SET NOT NULL;
-- A business with several branches gets one payout with no single salon.
ALTER TABLE "payouts" ALTER COLUMN "salonId" DROP NOT NULL;

ALTER TABLE "payouts" ADD CONSTRAINT "payouts_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "salon_owners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "payouts_ownerId_status_idx" ON "payouts"("ownerId", "status");

-- One transfer reference pays one payout. Earlier duplicates (test data) keep
-- the oldest row's reference; the later ones get a "(dup <id>)" suffix.
UPDATE "payouts" p
SET "reference" = p."reference" || ' (dup ' || LEFT(p."id", 8) || ')'
FROM (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "method", "reference" ORDER BY "createdAt", "id") AS rn
  FROM "payouts"
  WHERE "reference" IS NOT NULL
) d
WHERE p."id" = d."id" AND d.rn > 1;

-- Partial, so not in the Prisma schema.
CREATE UNIQUE INDEX "payouts_method_reference_key"
  ON "payouts"("method", "reference") WHERE "reference" IS NOT NULL;
