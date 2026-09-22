-- A slot's place in its day for this salon + service + counter. The serial a
-- customer is given is copied from here, so it follows slot time rather than
-- the order people happened to book in.
ALTER TABLE "slots" ADD COLUMN "sequenceNo" INTEGER;

CREATE INDEX "slots_salonId_serviceId_counterId_date_idx" ON "slots"("salonId", "serviceId", "counterId", "date");

-- Number every existing slot 1..N within its day, in start-time order.
-- "HH:mm" is zero-padded, so ordering the text orders the time.
UPDATE "slots" s SET "sequenceNo" = r.rn FROM (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY "salonId","serviceId","counterId","date" ORDER BY "startTime") AS rn
  FROM "slots") r
WHERE s.id = r.id;

-- correct the numbers customers already hold for upcoming bookings
UPDATE "appointments" a SET "serialNumber" = s."sequenceNo"
FROM "slots" s
WHERE a."slotId" = s.id
  AND a.status IN ('PENDING','CONFIRMED')
  AND a."appointmentDate" >= CURRENT_DATE;
