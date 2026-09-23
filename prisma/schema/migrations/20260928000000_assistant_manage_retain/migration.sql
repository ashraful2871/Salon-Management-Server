-- Phase 7: reminders, the one-time review ask, and per-message feedback.
--
-- Hand-written (see db-migrate.md): `migrate dev` would drop the pgvector and
-- PostGIS indexes it cannot see. Purely additive - five nullable columns and
-- one index, no DROP.

-- AlterTable: reminder stamps. The job selects on a window plus a null stamp,
-- which is what keeps a second run (or a restart) from emailing twice.
ALTER TABLE "appointments" ADD COLUMN "reminder24At" TIMESTAMP(3);
ALTER TABLE "appointments" ADD COLUMN "reminder2hAt" TIMESTAMP(3);
-- AlterTable: when the chat asked for a review, so it asks once per booking.
ALTER TABLE "appointments" ADD COLUMN "reviewAskedAt" TIMESTAMP(3);

-- CreateIndex: the reminder scan is "CONFIRMED, in the next two days".
CREATE INDEX "appointments_status_appointmentDate_idx" ON "appointments"("status", "appointmentDate");

-- AlterTable: 👍/👎 on an assistant message, and the optional reason.
ALTER TABLE "assistant_messages" ADD COLUMN "feedback" INTEGER;
ALTER TABLE "assistant_messages" ADD COLUMN "feedbackReason" TEXT;
