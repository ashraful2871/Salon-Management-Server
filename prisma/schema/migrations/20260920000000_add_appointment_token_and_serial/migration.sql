-- Queue identity for a booking: the short code the customer quotes at the
-- counter, and their place in the line for that salon + service + day.
ALTER TABLE "appointments" ADD COLUMN "token" TEXT;
ALTER TABLE "appointments" ADD COLUMN "serialNumber" INTEGER;

CREATE UNIQUE INDEX "appointments_token_key" ON "appointments"("token");

-- Backs the "what serial comes next" lookup run on every booking.
CREATE INDEX "appointments_salonId_serviceId_appointmentDate_idx"
  ON "appointments"("salonId", "serviceId", "appointmentDate");

-- A late cancellation splits the deposit, so it is neither RELEASED nor
-- FORFEITED.
ALTER TYPE "DepositStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_FORFEITED';
