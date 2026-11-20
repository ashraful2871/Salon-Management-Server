-- Referral Phase 1, part 2 of 2: referral tables, booking promo columns and
-- the database rules the program must never break.

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('PENDING_VERIFICATION', 'JOINED', 'QUALIFIED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ReferralChannel" AS ENUM ('LINK', 'CODE');

-- CreateEnum
CREATE TYPE "RewardKind" AS ENUM ('REFEREE_WELCOME', 'REFERRER_BONUS', 'MANUAL_GRANT');

-- CreateEnum
CREATE TYPE "RewardStatus" AS ENUM ('PENDING_REVIEW', 'AVAILABLE', 'RESERVED', 'REDEEMED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "RewardScope" AS ENUM ('ALL', 'SALON', 'HOME');


-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "promoDiscountMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "promoLabel" TEXT;

-- AlterTable
ALTER TABLE "home_bookings" ADD COLUMN     "promoDiscountMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "promoLabel" TEXT;

-- CreateTable
CREATE TABLE "referral_codes" (
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "blockedAt" TIMESTAMP(3),
    "blockedReason" TEXT,
    "deviceHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ipHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "refereeId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "channel" "ReferralChannel" NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "riskFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "refereeIpHash" TEXT,
    "refereeDeviceHash" TEXT,
    "joinedAt" TIMESTAMP(3),
    "qualifiedAt" TIMESTAMP(3),
    "qualifyingAppointmentId" TEXT,
    "qualifyingHomeBookingId" TEXT,
    "referrerRewardSkip" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "rejectedReason" TEXT,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_rewards" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "referralId" TEXT,
    "kind" "RewardKind" NOT NULL,
    "status" "RewardStatus" NOT NULL,
    "percentBps" INTEGER NOT NULL,
    "maxDiscountMinor" INTEGER NOT NULL,
    "minOrderMinor" INTEGER NOT NULL DEFAULT 0,
    "scope" "RewardScope" NOT NULL,
    "firstBookingOnly" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "appointmentId" TEXT,
    "homeBookingId" TEXT,
    "discountMinor" INTEGER NOT NULL DEFAULT 0,
    "phoneHash" TEXT,
    "remindedAt" TIMESTAMP(3),
    "reservedAt" TIMESTAMP(3),
    "redeemedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokeReason" TEXT,
    "grantedById" TEXT,
    "grantReason" TEXT,
    "expiredReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_events" (
    "id" TEXT NOT NULL,
    "referralId" TEXT,
    "rewardId" TEXT,
    "type" TEXT NOT NULL,
    "actorId" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referral_codes_code_key" ON "referral_codes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_refereeId_key" ON "referrals"("refereeId");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_qualifyingAppointmentId_key" ON "referrals"("qualifyingAppointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_qualifyingHomeBookingId_key" ON "referrals"("qualifyingHomeBookingId");

-- CreateIndex
CREATE INDEX "referrals_referrerId_status_createdAt_idx" ON "referrals"("referrerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "referrals_status_createdAt_idx" ON "referrals"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "referral_rewards_appointmentId_key" ON "referral_rewards"("appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "referral_rewards_homeBookingId_key" ON "referral_rewards"("homeBookingId");

-- CreateIndex
CREATE INDEX "referral_rewards_userId_status_expiresAt_idx" ON "referral_rewards"("userId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "referral_rewards_status_expiresAt_idx" ON "referral_rewards"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "referral_rewards_referralId_kind_key" ON "referral_rewards"("referralId", "kind");

-- CreateIndex
CREATE INDEX "referral_events_referralId_createdAt_idx" ON "referral_events"("referralId", "createdAt");

-- CreateIndex
CREATE INDEX "referral_events_rewardId_createdAt_idx" ON "referral_events"("rewardId", "createdAt");

-- AddForeignKey
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_refereeId_fkey" FOREIGN KEY ("refereeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "referrals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "referrals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "referral_rewards"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Raw SQL Prisma cannot express.
-- ---------------------------------------------------------------------------

-- A reward's numbers are sane.
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_numbers" CHECK (
  "percentBps" BETWEEN 1 AND 10000 AND "maxDiscountMinor" >= 0 AND "minOrderMinor" >= 0 AND "discountMinor" >= 0);

-- A reward is held by at most one booking, and only RESERVED / REDEEMED hold one.
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_one_booking" CHECK (
  NOT ("appointmentId" IS NOT NULL AND "homeBookingId" IS NOT NULL)
  AND (("status" IN ('RESERVED','REDEEMED')) = ("appointmentId" IS NOT NULL OR "homeBookingId" IS NOT NULL)));

-- Only a manual grant has no referral behind it.
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_kind_source" CHECK (
  ("kind" = 'MANUAL_GRANT') = ("referralId" IS NULL));

-- One welcome reward used (reserved or redeemed) per phone.
CREATE UNIQUE INDEX "referral_rewards_welcome_phone" ON "referral_rewards" ("phoneHash")
  WHERE "kind" = 'REFEREE_WELCOME' AND "status" IN ('RESERVED','REDEEMED');

-- Nobody refers themselves.
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_not_self" CHECK ("referrerId" <> "refereeId");

-- A promo never exceeds what it discounts.
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_promo" CHECK (
  "promoDiscountMinor" >= 0 AND "promoDiscountMinor" <= "totalMinor");
ALTER TABLE "home_bookings" ADD CONSTRAINT "home_bookings_promo" CHECK (
  "promoDiscountMinor" >= 0 AND "promoDiscountMinor" <= "subtotalMinor");
