-- Approximate-nearest-neighbour index for AI salon search.
-- Without it every search is a sequential scan with a distance computation per row.
-- Prisma cannot express this on an Unsupported("vector") column, so it lives here.
CREATE INDEX IF NOT EXISTS salons_embedding_hnsw
  ON salons USING hnsw (embedding vector_cosine_ops);

-- Supports the status/isDeleted filter that runs alongside the vector ordering.
CREATE INDEX IF NOT EXISTS salons_status_is_deleted_idx
  ON salons (status, "isDeleted");
