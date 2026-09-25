import { createHash } from "crypto";
import { ServiceCategory } from "@prisma/client";
import prisma from "../../shared/prisma";
import { CATEGORY_LABELS } from "./ai.constants";
import {
  embedDocument,
  embeddingModel,
  isGeminiConfigured,
  toVectorLiteral,
} from "./ai.gemini";

/**
 * Keeps `salons.embedding` in step with what each salon actually offers.
 *
 * Before this, a vector was written once when a salon was created - usually
 * before it had a single service - by a fire-and-forget call whose errors went
 * to `.catch(console.error)`. Service changes never re-embedded, and the manual
 * backfill was never run, so 12 of 13 salons had no vector and could not be
 * found at all. Now:
 *
 * - every write that changes what a salon offers calls `scheduleReindex`,
 * - each vector carries its model and a hash of the exact text it came from,
 *   so unchanged salons cost nothing and changed ones are always redone,
 * - `syncSearchIndex` runs on a timer and repairs anything a crash, a Gemini
 *   outage or a direct database edit left behind.
 */

/**
 * Bump when `buildSalonDocument` changes shape. It is part of the stored
 * hash, so the sync job re-embeds every salon on its next runs by itself.
 */
export const DOCUMENT_VERSION = "salon-doc-v2";

const DEBOUNCE_MS = 3_000;
const SYNC_BATCH = 25;
/** Owner-written text is capped so one essay cannot crowd out the services. */
const MAX_DESCRIPTION_CHARS = 1_200;
const MAX_SERVICES = 60;

type DocumentSalon = {
  name: string;
  description: string | null;
  address: string;
  area: string;
  district: string;
  division: string;
  city: string;
  services: Array<{
    name: string;
    category: ServiceCategory;
    duration: number;
    description: string | null;
  }>;
};

const present = (value?: string | null) => {
  const trimmed = value?.trim();
  return trimmed && trimmed.toUpperCase() !== "N/A" ? trimmed : "";
};

const uniqueCaseless = (values: string[]) => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * What a salon is, in words, for the embedding model: where it is, what it
 * offers and how the owner describes it.
 *
 * Prices and ratings are deliberately left out. The search scores them
 * exactly from the database; in a vector they are fuzzy at best, and they
 * change often enough that keeping them here would re-embed salons for
 * nothing.
 */
export const buildSalonDocument = (salon: DocumentSalon) => {
  const place = uniqueCaseless(
    [salon.area, salon.district, salon.division, salon.city].map(present),
  ).join(", ");

  const services = salon.services.slice(0, MAX_SERVICES).map((service) => {
    const detail = present(service.description);
    return `${service.name} (${CATEGORY_LABELS[service.category].toLowerCase()}, ${service.duration} min)${detail ? `: ${detail.slice(0, 120)}` : ""}`;
  });

  const offers = uniqueCaseless(
    salon.services.map((s) => CATEGORY_LABELS[s.category].toLowerCase()),
  );

  const description = present(salon.description).slice(
    0,
    MAX_DESCRIPTION_CHARS,
  );

  const lines = [
    `${salon.name} is a salon in ${place || "Bangladesh"}.`,
    present(salon.address) && `Address: ${present(salon.address)}.`,
    description,
    services.length
      ? `Services: ${services.join("; ")}.`
      : "No services are listed yet.",
    offers.length ? `Offers: ${offers.join(", ")}.` : "",
  ].filter(Boolean);

  return { title: salon.name, text: lines.join("\n") };
};

/** "<document version>:<sha256>" - the version is readable from SQL. */
const documentHash = (model: string, doc: { title: string; text: string }) =>
  `${DOCUMENT_VERSION}:${createHash("sha256")
    .update(`${model}\n${doc.title}\n${doc.text}`)
    .digest("hex")}`;

export type IndexOutcome =
  | "embedded"
  | "unchanged"
  | "skipped"
  | "missing"
  | "unconfigured";

/**
 * Embeds one salon if what it would embed differs from what is stored.
 * Throws when Gemini fails, so callers decide whether that is worth a log
 * line (the sync job retries on its next run either way).
 */
export const indexSalon = async (
  salonId: string,
  { force = false }: { force?: boolean } = {},
): Promise<IndexOutcome> => {
  if (!isGeminiConfigured()) return "unconfigured";

  // Taken before the read: a write that lands while the embedding is in
  // flight leaves updatedAt > embeddedAt, so the sync job redoes it.
  const startedAt = new Date();

  const salon = await prisma.salon.findUnique({
    where: { id: salonId },
    select: {
      name: true,
      description: true,
      address: true,
      area: true,
      district: true,
      division: true,
      city: true,
      status: true,
      isDeleted: true,
      embeddingModel: true,
      embeddingHash: true,
      services: {
        where: { isDeleted: false, isActive: true },
        select: {
          name: true,
          category: true,
          duration: true,
          description: true,
        },
        orderBy: [{ category: "asc" }, { name: "asc" }],
      },
    },
  });

  if (!salon) return "missing";
  // Only ACTIVE salons are searchable. One that is approved later becomes
  // stale by its own status change and is picked up then.
  if (salon.isDeleted || salon.status !== "ACTIVE") return "skipped";

  const model = embeddingModel();
  const doc = buildSalonDocument(salon);
  const hash = documentHash(model, doc);

  if (!force && salon.embeddingModel === model && salon.embeddingHash === hash) {
    const [{ hasVector }] = await prisma.$queryRaw<{ hasVector: boolean }[]>`
      SELECT (embedding IS NOT NULL) AS "hasVector" FROM salons WHERE id = ${salonId}`;

    if (hasVector) {
      // Raw SQL on purpose: Prisma's @updatedAt would bump updatedAt and make
      // the salon look stale again.
      await prisma.$executeRaw`
        UPDATE salons SET "embeddedAt" = ${startedAt} WHERE id = ${salonId}`;
      return "unchanged";
    }
  }

  const vector = await embedDocument(doc.title, doc.text, {
    timeoutMs: 20_000,
    retries: 2,
  });

  await prisma.$executeRaw`
    UPDATE salons
    SET embedding = ${toVectorLiteral(vector)}::vector,
        "embeddingModel" = ${model},
        "embeddingHash" = ${hash},
        "embeddedAt" = ${startedAt}
    WHERE id = ${salonId}`;

  return "embedded";
};

const pending = new Map<string, NodeJS.Timeout>();
let warnedUnconfigured = false;

/**
 * Re-embeds a salon a moment after it changes. Saving a service list fires
 * several writes in a row; the debounce folds them into one embedding call.
 * Never throws and never delays the request that triggered it - if it fails,
 * `syncSearchIndex` finds the salon stale and tries again.
 */
export const scheduleReindex = (salonId: string, reason: string) => {
  if (!salonId) return;

  if (!isGeminiConfigured()) {
    if (!warnedUnconfigured) {
      console.warn(
        "[ai.index] GEMINI_API_KEY is not set - salons are not being embedded for AI search.",
      );
      warnedUnconfigured = true;
    }
    return;
  }

  clearTimeout(pending.get(salonId));

  const timer = setTimeout(() => {
    pending.delete(salonId);
    indexSalon(salonId)
      .then((outcome) => {
        if (outcome === "embedded") {
          console.log(`[ai.index] re-embedded ${salonId} (${reason})`);
        }
      })
      .catch((error: unknown) => {
        console.error(
          `[ai.index] ${reason}: embedding ${salonId} failed, the sync job will retry -`,
          error instanceof Error ? error.message : error,
        );
      });
  }, DEBOUNCE_MS);

  timer.unref?.();
  pending.set(salonId, timer);
};

/**
 * ACTIVE salons whose vector is missing, from another model, from an older
 * document version, or older than the salon or any of its services.
 */
const findStaleSalonIds = async (limit: number) => {
  const model = embeddingModel();
  const versionPrefix = `${DOCUMENT_VERSION}:%`;

  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT s.id
    FROM salons s
    WHERE s."isDeleted" = false
      AND s.status = 'ACTIVE'
      AND (
        s.embedding IS NULL
        OR s."embeddingModel" IS DISTINCT FROM ${model}
        OR s."embeddingHash" IS NULL
        OR s."embeddingHash" NOT LIKE ${versionPrefix}
        OR s."embeddedAt" IS NULL
        OR s."embeddedAt" < s."updatedAt"
        OR EXISTS (
          SELECT 1 FROM services sv
          WHERE sv."salonId" = s.id AND sv."updatedAt" > s."embeddedAt"
        )
      )
    ORDER BY (s.embedding IS NULL) DESC, s."updatedAt" DESC
    LIMIT ${limit}`;

  return rows.map((row) => row.id);
};

export type SyncReport = {
  checked: number;
  embedded: number;
  unchanged: number;
  skipped: number;
  failed: number;
  failures: Array<{ id: string; error: string }>;
};

/**
 * The safety net behind `scheduleReindex`. Idempotent - an unchanged salon
 * only has its timestamp touched - so running it on several instances, or
 * right after a manual backfill, is harmless.
 */
export const syncSearchIndex = async (
  limit = SYNC_BATCH,
): Promise<SyncReport> => {
  const report: SyncReport = {
    checked: 0,
    embedded: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    failures: [],
  };

  if (!isGeminiConfigured()) return report;

  const ids = await findStaleSalonIds(limit);
  report.checked = ids.length;

  // One at a time: this is background work and should never compete with
  // live searches for the embedding quota.
  for (const id of ids) {
    try {
      const outcome = await indexSalon(id);
      if (outcome === "embedded") report.embedded += 1;
      else if (outcome === "unchanged") report.unchanged += 1;
      else report.skipped += 1;
    } catch (error) {
      report.failed += 1;
      report.failures.push({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (report.embedded || report.failed) {
    console.log(
      `[ai.index] sync: ${report.embedded} embedded, ${report.unchanged} unchanged, ${report.failed} failed of ${report.checked} stale`,
    );
  }

  return report;
};

/**
 * Embeds every ACTIVE salon that needs it; `force` redoes all of them. For the
 * backfill script and the admin endpoint - the timer does this in batches.
 */
export const reindexAll = async ({ force = false } = {}) => {
  const salons = await prisma.salon.findMany({
    where: { isDeleted: false, status: "ACTIVE" },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });

  const result = {
    total: salons.length,
    embedded: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    failures: [] as Array<{ id: string; name: string; error: string }>,
  };

  for (const salon of salons) {
    try {
      const outcome = await indexSalon(salon.id, { force });
      if (outcome === "unconfigured") {
        throw new Error("GEMINI_API_KEY is not configured");
      }
      if (outcome === "embedded") result.embedded += 1;
      else if (outcome === "unchanged") result.unchanged += 1;
      else result.skipped += 1;
    } catch (error) {
      result.failed += 1;
      result.failures.push({
        id: salon.id,
        name: salon.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
};

/** How much of the catalogue AI search can currently see, and how fresh. */
export const indexCoverage = async () => {
  const model = embeddingModel();
  const versionPrefix = `${DOCUMENT_VERSION}:%`;

  const [row] = await prisma.$queryRaw<
    Array<{ active: number; embedded: number; current: number }>
  >`
    SELECT
      COUNT(*)::int AS active,
      COUNT(*) FILTER (WHERE s.embedding IS NOT NULL)::int AS embedded,
      COUNT(*) FILTER (
        WHERE s.embedding IS NOT NULL
          AND s."embeddingModel" = ${model}
          AND s."embeddingHash" LIKE ${versionPrefix}
          AND s."embeddedAt" >= s."updatedAt"
          AND NOT EXISTS (
            SELECT 1 FROM services sv
            WHERE sv."salonId" = s.id AND sv."updatedAt" > s."embeddedAt"
          )
      )::int AS current
    FROM salons s
    WHERE s."isDeleted" = false AND s.status = 'ACTIVE'`;

  return {
    model,
    documentVersion: DOCUMENT_VERSION,
    activeSalons: row.active,
    embedded: row.embedded,
    upToDate: row.current,
    missing: row.active - row.embedded,
    stale: row.embedded - row.current,
  };
};

export const aiIndexer = {
  buildSalonDocument,
  indexSalon,
  scheduleReindex,
  syncSearchIndex,
  reindexAll,
  indexCoverage,
};
