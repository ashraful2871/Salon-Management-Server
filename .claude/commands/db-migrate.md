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
- **Review every generated migration for `DROP INDEX` / `DROP EXTENSION`.**
  Prisma cannot see `salons_embedding_hnsw` or `salons_geog_gist` and may try
  to drop them (prisma#28414). Delete those lines before applying.
- `migrate dev` cannot replay history into a shadow DB (the pgvector column
  was created with `db push`). Recent migrations are hand-written SQL in a new
  `prisma/schema/migrations/<timestamp>_$1/migration.sql`, applied with
  `npx prisma migrate deploy`.

Steps:

1. `npx prisma migrate dev --name $1` (or hand-write the SQL, see above)
2. Review the generated SQL and add any raw statements the schema cannot express.
   Remove any `DROP INDEX` / `DROP EXTENSION` for the hand-written indexes.
3. `npx prisma generate`
4. `npm run build` to confirm the client still type-checks.
5. Check the schema and the database agree:
   `npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema --script`
   It must not mention `spatial_ref_sys` or `DROP EXTENSION`. The only
   acceptable leftover is the known `DROP INDEX "salons_embedding_hnsw"` line.

Report the migration directory that was created and the SQL it contains.
