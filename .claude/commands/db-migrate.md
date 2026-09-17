---
description: Create and apply a Prisma migration, respecting this repo's schema-folder layout
argument-hint: <migration_name_in_snake_case>
---

Create a migration named `$1`.

Before running anything, note the layout gotchas in this repo:

- `package.json` sets `"prisma": { "schema": "./prisma/schema" }` — models are
  split across `prisma/schema/*.prisma`, not a single `schema.prisma`.
- The live migration history is **`prisma/schema/migrations/`**. The top-level
  `prisma/migrations/` directory is a stale UTF-16 leftover — never add to it.
- Anything Prisma cannot express (the pgvector HNSW index on
  `salons.embedding`, which is an `Unsupported("vector(768)")` column) must be
  hand-written into the generated migration SQL, as
  `20260917010000_add_salon_embedding_hnsw_index` does.

Steps:

1. `npx prisma migrate dev --name $1`
2. Review the generated SQL and add any raw statements the schema cannot express.
3. `npx prisma generate`
4. `npm run build` to confirm the client still type-checks.

Report the migration directory that was created and the SQL it contains.
