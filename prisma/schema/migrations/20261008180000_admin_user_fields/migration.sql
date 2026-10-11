-- Admin Phase 4: user status reasons, timed suspensions, activity and test-data flag.
ALTER TABLE "users" ADD COLUMN "isTest" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "statusReason" TEXT;
ALTER TABLE "users" ADD COLUMN "statusChangedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "suspendedUntil" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "lastActiveAt" TIMESTAMP(3);

-- Accounts created by the Dhaka seed script.
UPDATE "users" SET "isTest" = true WHERE "email" LIKE '%@seed.example.com';

-- The hourly users.unsuspend job and the admin users list.
CREATE INDEX "users_status_suspendedUntil_idx" ON "users"("status", "suspendedUntil");
CREATE INDEX "users_createdAt_idx" ON "users"("createdAt");
