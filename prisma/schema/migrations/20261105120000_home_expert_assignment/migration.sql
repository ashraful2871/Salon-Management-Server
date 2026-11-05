-- Home Service: an "any available expert" booking waits for the salon to
-- assign an expert. expert_id stays required (it holds the time, and the
-- overlap exclusion and gender CHECKs keep working); expertAssignedAt says
-- whether the salon has actually chosen. Null = not assigned yet.
ALTER TABLE "home_bookings" ADD COLUMN "expertAssignedAt" TIMESTAMPTZ(3);
ALTER TABLE "home_bookings" ADD COLUMN "expertAssignedById" TEXT;

-- Every booking made before this was assigned at booking time.
UPDATE "home_bookings" SET "expertAssignedAt" = COALESCE("confirmedAt", "createdAt");

