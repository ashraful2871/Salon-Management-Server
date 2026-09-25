-- AI search index bookkeeping (AI_REPORT.md). Written by hand, applied with
-- `npx prisma migrate deploy` (see .claude/commands/db-migrate.md).

-- Which model and which document produced each salon's vector. Without these
-- a model switch or a changed service list left old, incomparable vectors in
-- place and nothing noticed; now the indexer's sync job re-embeds them.
ALTER TABLE "salons"
  ADD COLUMN IF NOT EXISTS "embeddingModel" TEXT,
  ADD COLUMN IF NOT EXISTS "embeddingHash"  TEXT,
  ADD COLUMN IF NOT EXISTS "embeddedAt"     TIMESTAMP(3);

-- 20260917010000 created this index and is recorded as applied, but the index
-- is missing from the live database: `prisma db push` drops indexes Prisma
-- cannot see. IF NOT EXISTS makes this a no-op wherever it survived.
CREATE INDEX IF NOT EXISTS salons_embedding_hnsw
  ON salons USING hnsw (embedding vector_cosine_ops);
