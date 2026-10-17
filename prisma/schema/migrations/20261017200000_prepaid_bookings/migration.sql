-- Owner Phase 15: full in-app payment.

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN "prepaidMinor" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "salons" ADD COLUMN "acceptsPrepay" BOOLEAN NOT NULL DEFAULT false;

-- What the wallet holds for a booking never exceeds its bill. NOT VALID: old
-- rows are not rescanned (a deposit predates this rule); every new or updated
-- row is checked.
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_prepaid_within_total"
  CHECK ("prepaidMinor" >= 0 AND "depositMinor" + "prepaidMinor" <= "totalMinor") NOT VALID;
