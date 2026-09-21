-- Arrival is now an explicit step at the counter rather than something a job
-- infers from the clock, so a customer who is sitting in the chair can never
-- be swept into NO_SHOW.
ALTER TYPE "AppointmentStatus" ADD VALUE 'CHECKED_IN' BEFORE 'IN_PROGRESS';

-- Who checked the customer in and who completed the booking, and when. The
-- *ById columns are plain user ids with no foreign key: an audit trail. A null
-- completedById means the stale-checkout job closed the booking.
ALTER TABLE "appointments" ADD COLUMN     "checkedInAt" TIMESTAMP(3),
ADD COLUMN     "checkedInById" TEXT,
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "completedById" TEXT;
