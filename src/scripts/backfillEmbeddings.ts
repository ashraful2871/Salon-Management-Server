/**
 * Regenerates salon embeddings.
 *
 *   npm run backfill:embeddings          only salons with no vector
 *   npm run backfill:embeddings -- --all every active salon
 *
 * Use --all whenever aiService.buildSalonText changes: old vectors describe the
 * old text and are not comparable with newly generated ones.
 */
import { aiService } from "../app/modules/AI-Suggestion/ai.service";
import prisma from "../app/shared/prisma";

const main = async () => {
  const onlyMissing = !process.argv.includes("--all");

  console.log(
    onlyMissing
      ? "Embedding salons that have no vector yet..."
      : "Re-embedding every active salon..."
  );

  const result = await aiService.backfillEmbeddings(onlyMissing);

  console.log(
    `\nDone: ${result.succeeded} succeeded, ${result.failed} failed, ${result.total} considered.`
  );

  if (result.failures.length) {
    console.error("\nFailures:");
    result.failures.forEach((f) => console.error(`  ${f.name} (${f.id}): ${f.error}`));
  }

  const [{ count }] = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count FROM salons
    WHERE "isDeleted" = false AND status = 'ACTIVE' AND embedding IS NOT NULL
  `;
  console.log(`\nActive salons now searchable: ${count}`);

  await prisma.$disconnect();
  process.exit(result.failed > 0 ? 1 : 0);
};

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
