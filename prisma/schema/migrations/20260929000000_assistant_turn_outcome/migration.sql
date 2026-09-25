-- Phase 8: the outcome of each assistant turn, for GET /assistant/stats.
--
-- Hand-written (see db-migrate.md): `migrate dev` would drop the pgvector and
-- PostGIS indexes it cannot see. Purely additive - one nullable column, no
-- DROP. Rows written before this deploy read as NULL and are not counted.

-- AlterTable: ok | blocked | error | rate_limited | slot_taken | insufficient_funds
ALTER TABLE "assistant_messages" ADD COLUMN "outcome" TEXT;
