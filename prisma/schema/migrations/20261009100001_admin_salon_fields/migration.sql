-- Admin Phase 5: salon review trail and test-data flag.
ALTER TABLE "salons" ADD COLUMN "isTest" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "salons" ADD COLUMN "statusReason" TEXT;
ALTER TABLE "salons" ADD COLUMN "statusChangedAt" TIMESTAMP(3);
ALTER TABLE "salons" ADD COLUMN "statusChangedById" TEXT;
ALTER TABLE "salons" ADD COLUMN "approvedAt" TIMESTAMP(3);

-- Salons of test accounts, and every salon of the seed:dhaka owner account
-- (DEFAULT_OWNER in src/scripts/seedDhakaSalons.ts).
UPDATE "salons" s SET "isTest" = true
FROM "salon_owners" o JOIN "users" u ON u."id" = o."userId"
WHERE s."ownerId" = o."id"
  AND (u."isTest" = true OR u."email" = 'ashrafulash2871@gmail.com');

-- Approximation: no approval time was ever recorded, so the last update of an
-- ACTIVE salon stands in for it.
UPDATE "salons" SET "approvedAt" = "updatedAt" WHERE "status" = 'ACTIVE';

-- The admin salons list (default sort and the waiting-time sort).
CREATE INDEX "salons_createdAt_idx" ON "salons"("createdAt");
