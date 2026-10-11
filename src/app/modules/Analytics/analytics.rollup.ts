import { Prisma } from "@prisma/client";
import prisma from "../../shared/prisma";
import { addDays, dateOnly, dayStart, daySql, dhakaDay, utcTs } from "./analytics.days";
import { hasTestVariant, METRICS, type DailyMetric, type SnapshotMetric } from "./analytics.metrics";

/**
 * Fills `metric_daily` from the dictionary.
 *
 *   rollupRange / rollupDay   recompute daily metrics for whole Dhaka days
 *   runAnalyticsRollup        job, hourly: D-1…D-3, plus yesterday's closing
 *                             snapshots on the first run of a new Dhaka day
 *   runAnalyticsRetention     job, daily: trims the raw daily tables, after
 *                             rolling up what they feed
 *
 * Ordinary metrics are replaced (so a value that drops to zero disappears);
 * `volatile` ones read tables that get purged and are only ever raised, so a
 * recompute after the purge cannot lower history.
 */

const DAILY = METRICS.filter((m): m is DailyMetric => m.kind === "daily");
const SNAPSHOTS = METRICS.filter((m): m is SnapshotMetric => m.kind === "snapshot");
const WRITE_CHUNK = 1000;

type Row = { day: string; metric: string; dimension: string; value: number };

const selected = (only?: string[]) => (m: { id: string }) =>
  !only || only.some((p) => m.id === p || (p.endsWith(".") && m.id.startsWith(p)));

const variants = (m: DailyMetric | SnapshotMetric) => (hasTestVariant(m) ? [false, true] : [false]);
const storedDim = (dimension: string, includeTest: boolean) => (includeTest ? `*${dimension}` : dimension);

const upsertMax = async (rows: Row[]) => {
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    await prisma.$executeRaw`
      INSERT INTO metric_daily (day, metric, dimension, value, "computedAt")
      VALUES ${Prisma.join(chunk.map((r) => Prisma.sql`(${r.day}::date, ${r.metric}, ${r.dimension}, ${r.value}, now())`))}
      ON CONFLICT (day, metric, dimension)
      DO UPDATE SET value = GREATEST(metric_daily.value, EXCLUDED.value), "computedAt" = now()`;
  }
};

/** Recomputes the daily metrics (or those matching `only`: ids or "prefix.") for [fromDay, toDay]. */
export const rollupRange = async (fromDay: string, toDay: string, opts: { only?: string[] } = {}) => {
  const from = dayStart(fromDay);
  const to = dayStart(addDays(toDay, 1));
  const metrics = DAILY.filter(selected(opts.only));

  const replace: Row[] = [];
  const raise: Row[] = [];
  // One metric at a time keeps the connection pool free for live requests.
  for (const m of metrics) {
    for (const includeTest of variants(m)) {
      const found = await m.compute(from, to, { includeTest });
      for (const r of found) {
        if (r.day < fromDay || r.day > toDay || !Number.isFinite(r.value)) continue;
        (m.volatile ? raise : replace).push({
          day: r.day,
          metric: m.id,
          dimension: storedDim(r.dimension, includeTest),
          value: r.value,
        });
      }
    }
  }

  const replaced = metrics.filter((m) => !m.volatile).map((m) => m.id);
  await prisma.$transaction(
    async (tx) => {
      await tx.metricDaily.deleteMany({
        where: { day: { gte: dateOnly(fromDay), lte: dateOnly(toDay) }, metric: { in: replaced } },
      });
      for (let i = 0; i < replace.length; i += WRITE_CHUNK) {
        await tx.metricDaily.createMany({
          data: replace.slice(i, i + WRITE_CHUNK).map((r) => ({ ...r, day: dateOnly(r.day) })),
        });
      }
    },
    { timeout: 60_000 },
  );
  await upsertMax(raise);

  return { metrics: metrics.length, rows: replace.length + raise.length };
};

export const rollupDay = (day: string, opts: { only?: string[] } = {}) => rollupRange(day, day, opts);

/** Rolls up every day in `days` (one range from the first to the last). */
export const rollupDays = async (days: string[], opts: { only?: string[] } = {}) => {
  if (!days.length) return;
  const sorted = [...days].sort();
  await rollupRange(sorted[0], sorted[sorted.length - 1], opts);
};

/** Balances as they are now, stored as `day`'s closing value. */
export const recordSnapshots = async (day: string) => {
  const rows: Row[] = [];
  for (const m of SNAPSHOTS) {
    for (const includeTest of variants(m)) {
      for (const r of await m.compute({ includeTest })) {
        rows.push({ day, metric: m.id, dimension: storedDim(r.dimension, includeTest), value: r.value });
      }
    }
  }
  for (const r of rows) {
    await prisma.metricDaily.upsert({
      where: { day_metric_dimension: { day: dateOnly(r.day), metric: r.metric, dimension: r.dimension } },
      create: { ...r, day: dateOnly(r.day) },
      update: { value: r.value, computedAt: new Date() },
    });
  }
  return rows.length;
};

/**
 * Job `analytics.rollup`, hourly. The first run after 00:00 Dhaka also stores
 * the balances as yesterday's closing snapshot; the past cannot be recomputed,
 * so a day the server was down for keeps no snapshot.
 */
export const runAnalyticsRollup = async () => {
  const today = dhakaDay();
  const yesterday = addDays(today, -1);

  const haveSnapshot = await prisma.metricDaily.findFirst({
    where: { day: dateOnly(yesterday), metric: SNAPSHOTS[0].id },
    select: { day: true },
  });
  const snapshots = haveSnapshot ? 0 : await recordSnapshots(yesterday);

  const result = await rollupRange(addDays(today, -3), yesterday);
  console.log(
    `[jobs] analytics.rollup: ${result.rows} row(s) for ${addDays(today, -3)}…${yesterday}${
      snapshots ? `, ${snapshots} snapshot(s)` : ""
    }`,
  );
  return { rows: result.rows, snapshots };
};

/** The Dhaka dates of `column` over the rows matching `where`. */
const daysOf = async (table: string, column: string, where: Prisma.Sql) =>
  (
    await prisma.$queryRaw<Array<{ day: string }>>`
      SELECT DISTINCT ${daySql(`"${column}"`)} AS day FROM ${Prisma.raw(table)} WHERE ${where}`
  ).map((r) => r.day);

/** Called by the assistant purge before it deletes expired conversations. */
export const rollupBeforeConversationPurge = async (now: Date) =>
  rollupDays(await daysOf("assistant_conversations", "createdAt", Prisma.sql`"expiresAt" < ${utcTs(now)}`), {
    only: ["assistant."],
  });

/** Passed to `purgeHairTryOn`, which keeps no imports from other modules. */
export const rollupBeforeTryOnPurge = async (olderThan: Date) =>
  rollupDays(await daysOf("hair_tryon_uploads", "createdAt", Prisma.sql`"createdAt" < ${utcTs(olderThan)}`), {
    only: ["tryon."],
  });

const RETENTION = [
  { table: "visitor_daily", keepDays: 35, feeds: ["visitors.unique"] },
  { table: "search_query_daily", keepDays: 90, feeds: ["search."] },
  { table: "event_daily", keepDays: 400, feeds: ["funnel."] },
];

/** Job `analytics.retention`, daily. */
export const runAnalyticsRetention = async () => {
  const today = dhakaDay();
  const report: string[] = [];
  for (const r of RETENTION) {
    const cutoff = addDays(today, -r.keepDays);
    const table = Prisma.raw(r.table);
    const days = await prisma.$queryRaw<Array<{ day: string }>>`
      SELECT DISTINCT day::text AS day FROM ${table} WHERE day < ${cutoff}::date`;
    if (!days.length) continue;
    await rollupDays(
      days.map((d) => d.day),
      { only: r.feeds },
    );
    const deleted = await prisma.$executeRaw`DELETE FROM ${table} WHERE day < ${cutoff}::date`;
    report.push(`${r.table} ${deleted}`);
  }
  console.log(`[jobs] analytics.retention: ${report.length ? report.join(", ") : "nothing to trim"}`);
  return { trimmed: report };
};
