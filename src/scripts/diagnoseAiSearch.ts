/**
 * What AI search can see, and what it answers - against the real database
 * and Gemini.
 *
 *   npm run ai:diagnose                          coverage + the default queries
 *   npm run ai:diagnose -- "facial in Gulshan"   coverage + your queries
 *   npm run ai:diagnose -- --near 23.746,90.374 "salon near me"
 *
 * Read-only except for Gemini quota: about three model calls per query.
 */
import "../config";
import { aiService } from "../app/modules/AI-Suggestion/ai.service";
import { isGeminiConfigured } from "../app/modules/AI-Suggestion/ai.gemini";
import prisma from "../app/shared/prisma";

const DEFAULT_QUERIES = [
  "Cheap haircut in Dhanmondi",
  "Bridal makeup with good reviews",
  "Relaxing spa and massage near Gulshan",
  "Hair colouring under 2000 taka",
  "salon near me",
];

const main = async () => {
  const args = process.argv.slice(2);
  const nearIndex = args.indexOf("--near");
  const near =
    nearIndex >= 0 ? args.splice(nearIndex, 2)[1]?.split(",").map(Number) : undefined;
  const queries = args.length ? args : DEFAULT_QUERIES;

  console.log(`Gemini configured: ${isGeminiConfigured()}`);
  try {
    const coverage = await aiService.indexCoverage();
    console.log(
      `Index (${coverage.model}, ${coverage.documentVersion}): ` +
        `${coverage.upToDate}/${coverage.activeSalons} active salons up to date, ` +
        `${coverage.missing} missing, ${coverage.stale} stale\n`,
    );
  } catch (error) {
    // Search itself does not need the bookkeeping columns, so carry on.
    console.log(
      `Index coverage unavailable - has migration 20260923000000_ai_search_index_metadata been applied? (${
        error instanceof Error ? error.message.split("\n").pop() : error
      })\n`,
    );
  }

  for (const prompt of queries) {
    const started = Date.now();
    const result = await aiService.searchSalon({
      prompt,
      ...(near && near.length === 2
        ? { lat: near[0], lng: near[1], locationLabel: "test location" }
        : {}),
    });

    const intent = result.intent;
    console.log(`=== "${prompt}"  (${Date.now() - started} ms)`);
    console.log(
      `    understood (${intent.understoodBy}): ${JSON.stringify({
        categories: intent.categories.map((c) => c.value),
        terms: intent.serviceTerms,
        place: intent.place ?? intent.otherPlace,
        nearMe: intent.nearMe,
        maxPriceMinor: intent.maxPriceMinor,
        minRating: intent.minRating,
        sortBy: intent.sortBy,
        openNow: intent.openNow,
      })}`,
    );
    if (result.notes.length) console.log(`    notes: ${result.notes.join(" | ")}`);
    result.salons.forEach((s, i) =>
      console.log(
        `    ${i + 1}. [${s.matchType}] ${s.name} (${s.area}) score=${s.score}` +
          `${s.similarity !== null ? ` sim=${s.similarity.toFixed(3)}` : ""}` +
          `\n       + ${s.reasons.map((r) => r.text).join(" | ") || "-"}` +
          `${s.missing.length ? `\n       - ${s.missing.map((r) => r.text).join(" | ")}` : ""}`,
      ),
    );
    console.log(`    reply: ${result.aiResponse}\n`);
  }

  await prisma.$disconnect();
};

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
