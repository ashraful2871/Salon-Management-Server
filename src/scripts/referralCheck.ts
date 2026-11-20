/**
 * Pre-flight for the referral program: is the hash secret set, is the settings
 * registry readable, has the ledger got PLATFORM_PROMO yet, is the Neon test
 * branch reachable, and what does the customer data look like for the fraud
 * rules (verified share, usable phones, phones shared between accounts).
 *
 *   npm run referral:check
 *   REFERRAL_BRANCH_FILE=.env.other npm run referral:check   # another branch file
 *
 * Read-only: SELECTs only, against the `.env` database (the live one) and, for
 * `SELECT 1` + its migration state, the branch from `.env.homebranch`.
 * Prints counts and set/missing only - never a row, a phone, a secret or a URL.
 * Exits 1 if any ❌ check failed; ℹ️ lines never fail.
 */
import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import config from "../config";
import prisma from "../app/shared/prisma";
import { getSetting } from "../app/utils/settings";
import { readBranchTarget } from "./branchTarget";

const MIN_SECRET_LENGTH = 32;
const MIGRATIONS_DIR = path.join(process.cwd(), "prisma", "schema", "migrations");

let failures = 0;
const report = (ok: boolean, label: string, detail = "", fix = "") => {
  if (!ok) failures += 1;
  const hint = !ok && fix ? `\n   fix: ${fix}` : "";
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` - ${detail}` : ""}${hint}`);
};
const info = (label: string) => console.log(`ℹ️  ${label}`);

/** Last non-empty line of an error (Prisma puts the cause there), connection strings masked. */
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-1)[0]
    ?.replace(/postgres(ql)?:\/\/\S+/gi, "<url>") ?? "unknown error";

const pct = (part: number, whole: number) =>
  whole ? `${Math.round((part / whole) * 1000) / 10}%` : "-";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Prisma error code (P1001 = unreachable, P1000 = bad credentials, ...) when there is one. */
const errorCode = (error: unknown) => {
  const code = (error as { errorCode?: string; code?: string } | null)?.errorCode
    ?? (error as { code?: string } | null)?.code;
  return typeof code === "string" ? `${code} ` : "";
};

/**
 * A suspended Neon compute takes a few seconds to wake, longer than Prisma's
 * default 5 s connect timeout, so the first attempt can fail with "Can't reach"
 * while it wakes the compute. Retry before calling it down.
 */
const withRetry = async <T>(run: () => Promise<T>, tries = 3, delayMs = 3000): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= tries) throw error;
      await sleep(delayMs);
    }
  }
};

/** The URL with a 30 s connect timeout unless it already sets one. */
const withConnectTimeout = (url: string) => {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("connect_timeout")) parsed.searchParams.set("connect_timeout", "30");
    return parsed.toString();
  } catch {
    return url;
  }
};

/** Wake the `.env` database first, so a cold start can't fail the checks after it. */
const checkLiveDb = async () => {
  try {
    await withRetry(() => prisma.$queryRawUnsafe("SELECT 1"));
    return true;
  } catch (error) {
    report(false, "database (.env) reachable", `${errorCode(error)}${errorText(error)}`,
      "check DATABASE_URL; a Neon compute may be disabled in the console");
    return false;
  }
};

// ---------------------------------------------------------------------------

const checkSecret = () => {
  const secret = config.referral.hashSecret;
  if (!secret) {
    return report(false, "env REFERRAL_HASH_SECRET", "missing",
      "openssl rand -hex 32 into .env (Render gets it at launch, Phase 13)");
  }
  report(secret.length >= MIN_SECRET_LENGTH, "env REFERRAL_HASH_SECRET",
    secret.length >= MIN_SECRET_LENGTH ? "set" : `set but shorter than ${MIN_SECRET_LENGTH} chars`,
    "openssl rand -hex 32");
};

const checkSettings = async () => {
  try {
    // getSetting falls back to env/defaults when the table can't be read, so
    // read the table itself too: a fallback value must not pass this check.
    const stored = await prisma.platformSetting.count();
    const value = await getSetting("booking.commissionPercent");
    report(typeof value === "number", "settings registry readable",
      `booking.commissionPercent=${value}, ${stored} stored row(s)`, "check DATABASE_URL and migrations");
  } catch (error) {
    report(false, "settings registry readable", errorText(error), "check DATABASE_URL and migrations");
  }
};

const checkLedgerEnum = async () => {
  try {
    const rows = await prisma.$queryRawUnsafe<{ v: string }[]>(
      `SELECT unnest(enum_range(NULL::"LedgerAccount"))::text AS v`,
    );
    const values = rows.map((r) => r.v);
    if (values.includes("PLATFORM_PROMO")) {
      report(true, "LedgerAccount has PLATFORM_PROMO", `${values.length} values`);
    } else {
      info(`LedgerAccount has no PLATFORM_PROMO yet (expected before Phase 1): ${values.join(", ")}`);
    }
  } catch (error) {
    report(false, "LedgerAccount enum readable", errorText(error), "check DATABASE_URL and migrations");
  }
};

const checkBranch = async () => {
  const label = "Neon test branch reachable";
  const branch = readBranchTarget(process.env.REFERRAL_BRANCH_FILE || ".env.homebranch");
  const name = path.basename(branch.file);
  if (!branch.exists) return info(`${label} - skipped (no branch file ${name})`);
  if (!branch.url) {
    return report(false, label, `${name} has no DIRECT_URL / DATABASE_URL`,
      "put the Neon branch URL in the branch file");
  }
  if (!branch.matches) {
    return report(false, label,
      `HOME_CHECK_BRANCH_HOST ${branch.host ? "does not match the branch URL" : "missing"} in ${name}`,
      "set HOME_CHECK_BRANCH_HOST to the branch's host name (it guards against pointing at production)");
  }

  const client = new PrismaClient({ datasources: { db: { url: withConnectTimeout(branch.url) } } });
  try {
    await withRetry(() => client.$queryRawUnsafe("SELECT 1"));
    report(true, label, `host ${branch.host}`);
    const [state] = await client.$queryRawUnsafe<{ n: number; latest: string | null }[]>(
      `SELECT count(*)::int AS n, max(migration_name) AS latest
       FROM _prisma_migrations WHERE finished_at IS NOT NULL`,
    );
    info(`branch migrations applied: ${state.n}, latest ${state.latest ?? "-"}`);
  } catch (error) {
    report(false, label, `${errorCode(error)}${errorText(error)}`,
      "Prisma reports a rejected Neon login as \"Can't reach\" / a pool timeout too: copy a fresh " +
      "connection string from Neon console → the branch → Connect (the password changes on reset); " +
      "if the branch is gone, create one from Vercel → Storage → Open in Neon");
  } finally {
    await client.$disconnect();
  }
};

// ---------------------------------------------------------------------------

/**
 * Customers who could take part: CUSTOMER, not deleted, not test, not walk-in.
 * `norm` is the phone as the fraud rules will compare it: digits only, a
 * leading 88 dropped, kept only when it is a BD mobile number (01[3-9]xxxxxxxx).
 */
const CUSTOMERS = `
  WITH c AS (
    SELECT u.id, u."emailVerified", u.phone,
      CASE
        WHEN d ~ '^8801[3-9][0-9]{8}$' THEN substr(d, 3)
        WHEN d ~ '^01[3-9][0-9]{8}$' THEN d
      END AS norm
    FROM users u,
      LATERAL (SELECT regexp_replace(coalesce(u.phone, ''), '[^0-9]', '', 'g') AS d) x
    WHERE u.role = 'CUSTOMER' AND u."isDeleted" = false AND u."isTest" = false
      AND u.email NOT LIKE '%@walk-in.invalid'
  )`;

const printCounts = async () => {
  try {
    const [base] = await prisma.$queryRawUnsafe<{
      customers: number; verified: number; strict: number; normalizable: number;
      other: number; verifiedPhone: number;
    }[]>(`${CUSTOMERS}
      SELECT
        count(*)::int AS customers,
        count(*) FILTER (WHERE "emailVerified")::int AS verified,
        count(*) FILTER (WHERE phone ~ '^01[3-9][0-9]{8}$')::int AS strict,
        count(*) FILTER (WHERE norm IS NOT NULL)::int AS normalizable,
        count(*) FILTER (WHERE norm IS NULL AND coalesce(trim(phone), '') <> '')::int AS other,
        count(*) FILTER (WHERE "emailVerified" AND norm IS NOT NULL)::int AS "verifiedPhone"
      FROM c`);
    const n = base.customers;
    info(`customers (not deleted, not test, not walk-in): ${n}`);
    info(`  email-verified: ${base.verified} (${pct(base.verified, n)})`);
    info(`  phone matching ^01[3-9][0-9]{8}$: ${base.strict} (${pct(base.strict, n)}); ` +
      `after normalizing +88/spaces/dashes: ${base.normalizable}; other non-empty formats: ${base.other}`);
    info(`  verified with a usable phone: ${base.verifiedPhone} (${pct(base.verifiedPhone, n)})`);

    const [dup] = await prisma.$queryRawUnsafe<{ groups: number; largest: number; accounts: number }[]>(
      `${CUSTOMERS}
      SELECT count(*)::int AS groups,
        coalesce(max(k), 0)::int AS largest,
        coalesce(sum(k), 0)::int AS accounts
      FROM (SELECT count(*) AS k FROM c WHERE norm IS NOT NULL GROUP BY norm HAVING count(*) >= 2) g`);
    info(`  phones shared by >= 2 customers: ${dup.groups} distinct phone(s), ` +
      `${dup.accounts} account(s), largest group ${dup.largest}`);

    const [done] = await prisma.$queryRawUnsafe<{ booked: number }[]>(`${CUSTOMERS}
      SELECT count(*)::int AS booked FROM c
      WHERE EXISTS (SELECT 1 FROM appointments a WHERE a."customerId" = c.id AND a.status = 'COMPLETED')
         OR EXISTS (SELECT 1 FROM home_bookings h WHERE h."customerId" = c.id AND h.status = 'COMPLETED')`);
    info(`  with >= 1 COMPLETED appointment or home visit: ${done.booked} (${pct(done.booked, n)})`);
  } catch (error) {
    info(`counts unavailable: ${errorText(error)}`);
  }
};

const checkMigrations = async () => {
  try {
    const [state] = await prisma.$queryRawUnsafe<{ n: number; latest: string | null; failed: number }[]>(
      `SELECT
         count(*) FILTER (WHERE finished_at IS NOT NULL)::int AS n,
         max(migration_name) FILTER (WHERE finished_at IS NOT NULL) AS latest,
         count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::int AS failed
       FROM _prisma_migrations`,
    );
    info(`migrations applied: ${state.n}, latest ${state.latest ?? "-"}`);
    report(state.failed === 0, "no failed migration", state.failed ? `${state.failed} unfinished` : "",
      "resolve it with prisma migrate resolve before Phase 1 (migrate deploy refuses to run)");

    const applied = new Set(
      (await prisma.$queryRawUnsafe<{ migration_name: string }[]>(
        `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`,
      )).map((r) => r.migration_name),
    );
    const local = fs.existsSync(MIGRATIONS_DIR)
      ? fs.readdirSync(MIGRATIONS_DIR).filter((d) => fs.existsSync(path.join(MIGRATIONS_DIR, d, "migration.sql")))
      : [];
    const pending = local.filter((d) => !applied.has(d));
    info(`local migrations not applied here: ${pending.length}${pending.length ? ` (${pending.join(", ")})` : ""}`);
  } catch (error) {
    report(false, "_prisma_migrations readable", errorText(error), "check DATABASE_URL");
  }
};

const main = async () => {
  console.log("Referral pre-flight (read-only)\n");
  checkSecret();
  const liveOk = await checkLiveDb();
  if (liveOk) {
    await checkSettings();
    await checkLedgerEnum();
  }
  await checkBranch();
  if (liveOk) {
    await printCounts();
    await checkMigrations();
  }

  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
  // exitCode, not process.exit(): exiting while sockets are still closing
  // trips a libuv assertion on Windows (UV_HANDLE_CLOSING).
  process.exitCode = failures ? 1 : 0;
};

main()
  .catch((error) => {
    console.error("referral:check crashed:", errorText(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
