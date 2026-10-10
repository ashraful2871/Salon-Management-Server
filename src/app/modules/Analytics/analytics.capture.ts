import { Prisma } from "@prisma/client";
import prisma from "../../shared/prisma";
import { dhakaDay } from "./analytics.days";

/**
 * Live counters, written as they happen and never recomputed: search terms,
 * AI search outcomes and rejected events. Every function here is fire and
 * forget - it returns at once, swallows its own errors, and must never slow
 * or fail the request it rides on.
 */

const quietly = (label: string, work: () => Promise<unknown>) => {
  void work().catch((err) => console.error(`[analytics] ${label} failed`, err));
};

/** Adds to today's `metric_daily` rows (one statement for all of them). */
export const incrementMetrics = (rows: Array<{ metric: string; dimension?: string; by?: number }>) =>
  quietly("metric increment", async () => {
    if (!rows.length) return;
    const day = dhakaDay();
    await prisma.$executeRaw`
      INSERT INTO metric_daily (day, metric, dimension, value, "computedAt")
      VALUES ${Prisma.join(
        rows.map((r) => Prisma.sql`(${day}::date, ${r.metric}, ${r.dimension ?? ""}, ${r.by ?? 1}, now())`),
      )}
      ON CONFLICT (day, metric, dimension)
      DO UPDATE SET value = metric_daily.value + EXCLUDED.value, "computedAt" = now()`;
  });

const MAX_TERM = 60;
const EMAIL_LIKE = /\S+@\S+/;
const MANY_DIGITS = /\d{7,}/;

/**
 * Lower-case, trimmed, single-spaced, at most 60 characters. Null for terms
 * that could be personal: anything shaped like an email, or 7+ digits in a
 * row once spaces, dashes and dots are taken out (a phone number).
 */
export const normaliseTerm = (raw: string): string | null => {
  const term = raw.toLowerCase().replace(/\s+/g, " ").trim().slice(0, MAX_TERM).trim();
  if (!term) return null;
  if (EMAIL_LIKE.test(term) || MANY_DIGITS.test(term.replace(/[\s\-.+()]/g, ""))) return null;
  return term;
};

export type SearchSurface = "LIST" | "AI";

export const recordSearchTerm = (raw: string, surface: SearchSurface, zeroResults: boolean) =>
  quietly("search term", async () => {
    const term = normaliseTerm(raw);
    if (!term) return;
    const zero = zeroResults ? 1 : 0;
    await prisma.$executeRaw`
      INSERT INTO search_query_daily (day, term, surface, count, "zeroResults")
      VALUES (${dhakaDay()}::date, ${term}, ${surface}, 1, ${zero})
      ON CONFLICT (day, term, surface)
      DO UPDATE SET count = search_query_daily.count + 1,
                    "zeroResults" = search_query_daily."zeroResults" + ${zero}`;
  });

/** Histogram bucket edges (ms) for latency metrics; P50/P95 are read from them. */
export const LATENCY_BUCKETS_MS = [250, 500, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 12000, 20000, 30000, 60000];

export const latencyBucket = (ms: number) => {
  const edge = LATENCY_BUCKETS_MS.find((b) => ms <= b);
  return edge ? `le:${edge}` : "le:inf";
};

export type AiTier = "best" | "partial" | "alternative" | "none";

/** One `POST /ai/search`: the counters behind `ai.*`, plus the term. */
export const recordAiSearch = (input: {
  prompt: string;
  tier: AiTier;
  latencyMs: number;
  usedLlm: boolean;
  zeroResults: boolean;
}) => {
  incrementMetrics([
    { metric: "ai.searches" },
    { metric: "ai.tier", dimension: `tier:${input.tier}` },
    { metric: "ai.latency", dimension: latencyBucket(input.latencyMs) },
    ...(input.usedLlm ? [{ metric: "ai.llm" }] : []),
  ]);
  recordSearchTerm(input.prompt, "AI", input.zeroResults);
};
