-- Home Service data model (home-phase-1). Generated with prisma migrate diff, then the
-- hand-written constraints at the end, which Prisma cannot express and future diffs leave alone.

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- CreateEnum
CREATE TYPE "HomeAudience" AS ENUM ('LADIES', 'GENTS');

-- CreateEnum
CREATE TYPE "HomeServiceStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ExpertVerification" AS ENUM ('DRAFT', 'PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "HomeBookingStatus" AS ENUM ('PENDING_PAYMENT', 'CONFIRMED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED');

-- CreateEnum
CREATE TYPE "HomeNoShowParty" AS ENUM ('CUSTOMER', 'EXPERT');

-- CreateEnum
CREATE TYPE "AdvanceStatus" AS ENUM ('PENDING', 'HELD', 'APPLIED', 'RELEASED', 'PARTIALLY_FORFEITED', 'FORFEITED');

-- CreateEnum
CREATE TYPE "BalanceMethod" AS ENUM ('CASH', 'BKASH_TO_SALON', 'WALLET', 'NOT_COLLECTED');

-- CreateEnum
CREATE TYPE "HomeCategory" AS ENUM ('FACIAL', 'THREADING', 'WAXING', 'MAKEUP', 'MEHEDI', 'HAIR', 'MANICURE_PEDICURE', 'BRIDAL', 'MASSAGE', 'HAIRCUT', 'BEARD', 'GROOMING', 'OTHER');

-- CreateEnum
CREATE TYPE "HomeCancelPolicy" AS ENUM ('FREE', 'WINDOW', 'NON_REFUNDABLE');

-- CreateEnum
CREATE TYPE "HomeSafetyKind" AS ENUM ('SAFETY', 'QUALITY', 'MISMATCH', 'HARASSMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "HomeReportStatus" AS ENUM ('OPEN', 'REVIEWING', 'ACTIONED', 'DISMISSED');

-- AlterEnum
ALTER TYPE "IntentPurpose" ADD VALUE 'HOME_BOOKING';

-- AlterTable
ALTER TABLE "ledger_entries" ADD COLUMN     "homeBookingId" TEXT;

-- CreateTable
CREATE TABLE "home_service_profiles" (
    "id" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "isOn" BOOLEAN NOT NULL DEFAULT false,
    "ladiesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "gentsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "status" "HomeServiceStatus" NOT NULL DEFAULT 'DRAFT',
    "everApproved" BOOLEAN NOT NULL DEFAULT false,
    "pausedUntil" TIMESTAMPTZ(3),
    "pauseReason" TEXT,
    "suspendedReason" TEXT,
    "radiusKm" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "travelFeeMinor" INTEGER NOT NULL DEFAULT 0,
    "minOrderMinor" INTEGER NOT NULL DEFAULT 50000,
    "travelBufferMin" INTEGER NOT NULL DEFAULT 30,
    "dayStart" TEXT NOT NULL DEFAULT '09:00',
    "dayEnd" TEXT NOT NULL DEFAULT '20:00',
    "statusReason" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "home_service_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "home_experts" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "gender" "Gender" NOT NULL,
    "audience" "HomeAudience" NOT NULL,
    "verification" "ExpertVerification" NOT NULL DEFAULT 'DRAFT',
    "idDocFrontId" TEXT,
    "idDocBackId" TEXT,
    "selfieId" TEXT,
    "submittedAt" TIMESTAMPTZ(3),
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMPTZ(3),
    "rejectReason" TEXT,
    "headline" TEXT,
    "languages" TEXT[],
    "maxJobsPerDay" INTEGER NOT NULL DEFAULT 4,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalReviews" INTEGER NOT NULL DEFAULT 0,
    "completedJobs" INTEGER NOT NULL DEFAULT 0,
    "cancelledBySalon" INTEGER NOT NULL DEFAULT 0,
    "removedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "home_experts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "home_service_offerings" (
    "id" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "audience" "HomeAudience" NOT NULL,
    "category" "HomeCategory" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kitNote" TEXT,
    "durationMin" INTEGER NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "images" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "home_service_offerings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "home_expert_offerings" (
    "expertId" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,

    CONSTRAINT "home_expert_offerings_pkey" PRIMARY KEY ("expertId","offeringId")
);

-- CreateTable
CREATE TABLE "home_bookings" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "expertId" TEXT NOT NULL,
    "audience" "HomeAudience" NOT NULL,
    "expertAudience" "HomeAudience" NOT NULL,
    "status" "HomeBookingStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3) NOT NULL,
    "blockFrom" TIMESTAMPTZ(3) NOT NULL,
    "blockTo" TIMESTAMPTZ(3) NOT NULL,
    "serviceDate" DATE NOT NULL,
    "expiresAt" TIMESTAMPTZ(3),
    "addressLine" TEXT NOT NULL,
    "area" TEXT,
    "landmark" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "distanceKm" DOUBLE PRECISION NOT NULL,
    "recipientName" TEXT NOT NULL,
    "recipientIsWoman" BOOLEAN,
    "contactPhone" TEXT NOT NULL,
    "notes" TEXT,
    "subtotalMinor" INTEGER NOT NULL,
    "travelFeeMinor" INTEGER NOT NULL,
    "totalMinor" INTEGER NOT NULL,
    "advancePercent" INTEGER NOT NULL,
    "advanceMinor" INTEGER NOT NULL,
    "advanceStatus" "AdvanceStatus" NOT NULL DEFAULT 'PENDING',
    "balanceMinor" INTEGER NOT NULL,
    "balanceMethod" "BalanceMethod",
    "balanceCollectedMinor" INTEGER,
    "commissionBps" INTEGER NOT NULL,
    "policySnapshot" JSONB NOT NULL,
    "disclaimerText" TEXT NOT NULL,
    "policyAcceptedAt" TIMESTAMPTZ(3),
    "feeMinor" INTEGER NOT NULL DEFAULT 0,
    "refundedMinor" INTEGER,
    "paymentIntentId" TEXT,
    "startCodeTries" INTEGER NOT NULL DEFAULT 0,
    "confirmedAt" TIMESTAMPTZ(3),
    "enRouteAt" TIMESTAMPTZ(3),
    "arrivedAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelledBy" "CancelledBy",
    "cancelReason" TEXT,
    "noShowParty" "HomeNoShowParty",
    "noShowMarkedAt" TIMESTAMPTZ(3),
    "appealedAt" TIMESTAMPTZ(3),
    "appealReason" TEXT,
    "appealStatus" "AppealStatus",
    "appealResolvedAt" TIMESTAMPTZ(3),
    "appealResolvedById" TEXT,
    "rescheduleCount" INTEGER NOT NULL DEFAULT 0,
    "reminder24At" TIMESTAMPTZ(3),
    "reminder2hAt" TIMESTAMPTZ(3),
    "idempotencyKey" TEXT,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "home_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "home_booking_items" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "nameSnapshot" TEXT NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "durationMin" INTEGER NOT NULL,

    CONSTRAINT "home_booking_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "home_booking_events" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "fromStatus" "HomeBookingStatus",
    "toStatus" "HomeBookingStatus" NOT NULL,
    "actorId" TEXT,
    "actorRole" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "home_booking_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_addresses" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "addressLine" TEXT NOT NULL,
    "area" TEXT,
    "landmark" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "home_safety_reports" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reporterRole" TEXT NOT NULL,
    "kind" "HomeSafetyKind" NOT NULL,
    "details" TEXT NOT NULL,
    "status" "HomeReportStatus" NOT NULL DEFAULT 'OPEN',
    "handledById" TEXT,
    "handledAt" TIMESTAMPTZ(3),
    "supportTicketId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "home_safety_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "home_customer_blocks" (
    "userId" TEXT NOT NULL,
    "until" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "home_customer_blocks_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "home_service_profiles_salonId_key" ON "home_service_profiles"("salonId");

-- CreateIndex
CREATE UNIQUE INDEX "home_experts_staffId_key" ON "home_experts"("staffId");

-- CreateIndex
CREATE INDEX "home_experts_salonId_idx" ON "home_experts"("salonId");

-- CreateIndex
CREATE INDEX "home_experts_audience_verification_isActive_idx" ON "home_experts"("audience", "verification", "isActive");

-- CreateIndex
CREATE INDEX "home_service_offerings_salonId_audience_isActive_idx" ON "home_service_offerings"("salonId", "audience", "isActive");

-- CreateIndex
CREATE INDEX "home_expert_offerings_offeringId_idx" ON "home_expert_offerings"("offeringId");

-- CreateIndex
CREATE UNIQUE INDEX "home_bookings_code_key" ON "home_bookings"("code");

-- CreateIndex
CREATE UNIQUE INDEX "home_bookings_idempotencyKey_key" ON "home_bookings"("idempotencyKey");

-- CreateIndex
CREATE INDEX "home_bookings_customerId_status_idx" ON "home_bookings"("customerId", "status");

-- CreateIndex
CREATE INDEX "home_bookings_salonId_serviceDate_idx" ON "home_bookings"("salonId", "serviceDate");

-- CreateIndex
CREATE INDEX "home_bookings_expertId_startAt_idx" ON "home_bookings"("expertId", "startAt");

-- CreateIndex
CREATE INDEX "home_bookings_status_startAt_idx" ON "home_bookings"("status", "startAt");

-- CreateIndex
CREATE INDEX "home_bookings_status_expiresAt_idx" ON "home_bookings"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "home_booking_items_bookingId_idx" ON "home_booking_items"("bookingId");

-- CreateIndex
CREATE INDEX "home_booking_events_bookingId_createdAt_idx" ON "home_booking_events"("bookingId", "createdAt");

-- CreateIndex
CREATE INDEX "customer_addresses_userId_idx" ON "customer_addresses"("userId");

-- CreateIndex
CREATE INDEX "home_safety_reports_bookingId_idx" ON "home_safety_reports"("bookingId");

-- CreateIndex
CREATE INDEX "home_safety_reports_status_createdAt_idx" ON "home_safety_reports"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ledger_entries_homeBookingId_idx" ON "ledger_entries"("homeBookingId");

-- AddForeignKey
ALTER TABLE "home_service_profiles" ADD CONSTRAINT "home_service_profiles_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "salons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_experts" ADD CONSTRAINT "home_experts_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_experts" ADD CONSTRAINT "home_experts_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "salons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_service_offerings" ADD CONSTRAINT "home_service_offerings_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "salons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_expert_offerings" ADD CONSTRAINT "home_expert_offerings_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "home_experts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_expert_offerings" ADD CONSTRAINT "home_expert_offerings_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "home_service_offerings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_bookings" ADD CONSTRAINT "home_bookings_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_bookings" ADD CONSTRAINT "home_bookings_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "salons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_bookings" ADD CONSTRAINT "home_bookings_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "home_experts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_booking_items" ADD CONSTRAINT "home_booking_items_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "home_bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_booking_items" ADD CONSTRAINT "home_booking_items_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "home_service_offerings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_booking_events" ADD CONSTRAINT "home_booking_events_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "home_bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_safety_reports" ADD CONSTRAINT "home_safety_reports_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "home_bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_homeBookingId_fkey" FOREIGN KEY ("homeBookingId") REFERENCES "home_bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written: the database refuses a wrong-gender expert, an audience
-- mismatch, an unbalanced money row and overlapping active jobs for an expert.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "home_experts" ADD CONSTRAINT "home_experts_gender_audience" CHECK (
  ("gender" = 'FEMALE' AND "audience" = 'LADIES') OR ("gender" = 'MALE' AND "audience" = 'GENTS'));

ALTER TABLE "home_bookings" ADD CONSTRAINT "home_bookings_audience_match" CHECK ("audience" = "expertAudience");

ALTER TABLE "home_bookings" ADD CONSTRAINT "home_bookings_money" CHECK (
  "advanceMinor" >= 0 AND "balanceMinor" >= 0 AND "feeMinor" >= 0
  AND "advanceMinor" + "balanceMinor" = "totalMinor"
  AND "feeMinor" + COALESCE("refundedMinor", 0) <= "advanceMinor");

-- blockFrom/blockTo are timestamptz, so tstzrange over them is immutable and indexable.
ALTER TABLE "home_bookings" ADD CONSTRAINT "home_bookings_no_overlap"
  EXCLUDE USING gist ("expertId" WITH =, tstzrange("blockFrom", "blockTo", '[)') WITH &&)
  WHERE ("status" IN ('PENDING_PAYMENT', 'CONFIRMED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'));
