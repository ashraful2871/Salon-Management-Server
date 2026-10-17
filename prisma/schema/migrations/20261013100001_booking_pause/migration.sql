-- Owner Phase 6: online-booking pause per salon + dues tracking per owner.
-- Additive only.

ALTER TABLE "salons"
  ADD COLUMN IF NOT EXISTS "bookingPause" "BookingPause" NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS "bookingPauseReason" TEXT,
  ADD COLUMN IF NOT EXISTS "bookingPauseUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "bookingPausedAt" TIMESTAMP(3);

ALTER TABLE "salon_owners"
  ADD COLUMN IF NOT EXISTS "duesWarnedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "duesSince" TIMESTAMP(3);
