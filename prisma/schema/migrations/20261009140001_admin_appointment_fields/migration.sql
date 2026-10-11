-- AlterTable
ALTER TABLE "appointments" ADD COLUMN "startedAt" TIMESTAMP(3),
ADD COLUMN "cancelledAt" TIMESTAMP(3),
ADD COLUMN "cancelledBy" "CancelledBy";

-- CreateIndex
CREATE INDEX "appointments_createdAt_idx" ON "appointments"("createdAt");

-- Backfill: the last write to a cancelled booking was its cancellation.
-- Who cancelled it was never recorded, so cancelledBy stays null ("unknown").
UPDATE "appointments" SET "cancelledAt" = "updatedAt" WHERE "status" = 'CANCELLED' AND "cancelledAt" IS NULL;
