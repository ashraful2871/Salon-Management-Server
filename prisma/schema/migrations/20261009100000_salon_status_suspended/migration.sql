-- Admin Phase 5: an admin can suspend a salon. Alone in its own migration -
-- Postgres cannot use a new enum value in the transaction that added it.
ALTER TYPE "SalonStatus" ADD VALUE IF NOT EXISTS 'SUSPENDED';
