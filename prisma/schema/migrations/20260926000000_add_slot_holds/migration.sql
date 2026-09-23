-- Slot holds and the booking channel.
--
-- Hand-written rather than generated, because `prisma migrate dev` does not
-- know about `salons_embedding_hnsw` (pgvector) or `salons_geog_gist`
-- (PostGIS) and drops them on sight. Nothing here is destructive: one new
-- type, two nullable columns, one index, and one column with a default that
-- backfills every existing row to WEB - which is what they were.

-- CreateEnum
CREATE TYPE "BookingChannel" AS ENUM ('WEB', 'ASSISTANT', 'WALK_IN');

-- AlterTable: the soft reservation the chat takes while a customer chooses.
-- Both nullable, so every existing slot reads as unheld.
ALTER TABLE "slots" ADD COLUMN     "heldUntil" TIMESTAMP(3);
ALTER TABLE "slots" ADD COLUMN     "heldByUserId" TEXT;

-- CreateIndex: backs the "how many holds does this customer have" count and
-- any later sweep of lapsed ones.
CREATE INDEX "slots_heldUntil_idx" ON "slots"("heldUntil");

-- AlterTable: how the booking reached us. Every row that already exists came
-- through the review page or the counter, and WEB is the honest default for
-- both until a walk-in path sets it explicitly.
ALTER TABLE "appointments" ADD COLUMN     "bookedVia" "BookingChannel" NOT NULL DEFAULT 'WEB';
