/**
 * npm run analytics:backfill -- --days 365
 *
 * Recomputes the daily analytics metrics for the last N closed Dhaka days
 * (yesterday and before), 30 days at a time, and prints the progress.
 * Snapshots (balances) are skipped: the past cannot be recomputed. Metrics
 * that read purged tables only ever go up, so re-running it is safe.
 */
import prisma from "../app/shared/prisma";
import { addDays, dhakaDay } from "../app/modules/Analytics/analytics.days";
import { rollupRange } from "../app/modules/Analytics/analytics.rollup";

const CHUNK_DAYS = 30;

const argDays = () => {
  const i = process.argv.indexOf("--days");
  const n = i >= 0 ? Number(process.argv[i + 1]) : 30;
  if (!Number.isInteger(n) || n < 1 || n > 3650) throw new Error("--days must be a whole number from 1 to 3650");
  return n;
};

const main = async () => {
  const days = argDays();
  const last = addDays(dhakaDay(), -1);
  const first = addDays(last, -(days - 1));
  console.log(`[backfill] ${days} day(s): ${first} … ${last} (Asia/Dhaka)`);

  let done = 0;
  let rows = 0;
  const started = Date.now();
  for (let from = first; from <= last; from = addDays(from, CHUNK_DAYS)) {
    const chunkEnd = addDays(from, CHUNK_DAYS - 1);
    const to = chunkEnd < last ? chunkEnd : last;
    const t0 = Date.now();
    const result = await rollupRange(from, to);
    done += Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
    rows += result.rows;
    console.log(`[backfill] ${from} … ${to}: ${result.rows} row(s) in ${Date.now() - t0} ms  (${done}/${days} days)`);
  }
  console.log(`[backfill] done: ${rows} row(s) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
};

main()
  .catch((err) => {
    console.error("[backfill] failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
