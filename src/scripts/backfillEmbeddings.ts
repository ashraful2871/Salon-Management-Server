/**
 * Embeds salons for AI search.
 *
 *   npm run backfill:embeddings          salons whose vector is missing or stale
 *   npm run backfill:embeddings -- --all every active salon, changed or not
 *
 * The server's sync job does the first form on its own every 10 minutes, so
 * this is for a fresh database or for seeing the result right away. Changing
 * the embedding model or `buildSalonDocument` no longer needs --all: stored
 * vectors carry their model and document hash, and stale ones are redone.
 */
import "../config";
import { aiIndexer } from "../app/modules/AI-Suggestion/ai.indexer";
import prisma from "../app/shared/prisma";

const main = async () => {
  const force = process.argv.includes("--all");

  console.log(
    force
      ? "Re-embedding every active salon..."
      : "Embedding active salons that are missing or stale...",
  );

  const result = await aiIndexer.reindexAll({ force });

  console.log(
    `\nDone: ${result.embedded} embedded, ${result.unchanged} unchanged, ${result.skipped} skipped, ${result.failed} failed, ${result.total} active salons.`,
  );

  if (result.failures.length) {
    console.error("\nFailures:");
    result.failures.forEach((f) =>
      console.error(`  ${f.name} (${f.id}): ${f.error}`),
    );
  }

  const coverage = await aiIndexer.indexCoverage();
  console.log(
    `\nSearch index (${coverage.model}, ${coverage.documentVersion}): ${coverage.upToDate} of ${coverage.activeSalons} active salons up to date, ${coverage.missing} missing, ${coverage.stale} stale.`,
  );

  await prisma.$disconnect();
  process.exit(result.failed > 0 ? 1 : 0);
};

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
