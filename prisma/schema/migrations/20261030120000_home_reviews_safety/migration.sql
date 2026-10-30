-- Home Service Phase 9: a review belongs to a salon appointment or a home
-- visit (exactly one), home reviews name the expert, and a safety report
-- keeps the admin's note.

-- AlterTable
ALTER TABLE "reviews" ALTER COLUMN "appointmentId" DROP NOT NULL,
ADD COLUMN     "homeBookingId" TEXT,
ADD COLUMN     "homeExpertId" TEXT;

-- AlterTable
ALTER TABLE "home_safety_reports" ADD COLUMN     "handlerNote" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "reviews_homeBookingId_key" ON "reviews"("homeBookingId");

-- CreateIndex
CREATE INDEX "reviews_homeExpertId_status_idx" ON "reviews"("homeExpertId", "status");

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_homeBookingId_fkey" FOREIGN KEY ("homeBookingId") REFERENCES "home_bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_homeExpertId_fkey" FOREIGN KEY ("homeExpertId") REFERENCES "home_experts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Raw SQL (Prisma cannot express it): exactly one parent per review.
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_one_parent"
  CHECK (num_nonnulls("appointmentId", "homeBookingId") = 1);
