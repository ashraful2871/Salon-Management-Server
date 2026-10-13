-- Owner Phase 6: why a salon is not taking online bookings. In its own
-- migration because a new enum cannot be used in the transaction that adds it.

DO $$ BEGIN
  CREATE TYPE "BookingPause" AS ENUM ('NONE', 'OWNER', 'DUES');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
