/**
 * Pre-flight for Home Service: is the start-code secret set, can the database
 * do PostGIS + btree_gist exclusion constraints, is the private Cloudinary
 * preset for expert documents set up right, and is the settings registry
 * readable. Also prints salon/staff counts for planning.
 *
 *   npm run home:check
 *   npm run home:check -- --with-ddl   # + btree_gist smoke test on the Neon branch
 *
 * Read-only: SELECTs only. The --with-ddl smoke test runs inside a transaction
 * that is always rolled back, and only against the Neon branch URL from
 * .env.homebranch whose host contains HOME_CHECK_BRANCH_HOST.
 * Prints set/missing and pass/fail only - never a key, a secret or a URL.
 * Exits 1 if any check failed.
 */
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { v2 as cloudinary } from "cloudinary";
import config from "../config";
import prisma from "../app/shared/prisma";
import { getSetting } from "../app/utils/settings";
import { configureCloudinary, errorText } from "./hairTryOnLib";

const MIN_SECRET_LENGTH = 32;
const BRANCH_ENV_FILE = path.join(process.cwd(), ".env.homebranch");
const ROLLBACK = "home:check rollback";

let failures = 0;
const report = (ok: boolean, label: string, detail = "", fix = "") => {
  if (!ok) failures += 1;
  const hint = !ok && fix ? `\n   fix: ${fix}` : "";
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` - ${detail}` : ""}${hint}`);
};
const info = (label: string) => console.log(`ℹ️  ${label}`);

const checkSecret = () => {
  const secret = config.homeService.startCodeSecret;
  if (!secret) {
    return report(false, "env HOME_START_CODE_SECRET", "missing",
      "openssl rand -hex 32 into .env (Render gets it at launch)");
  }
  report(secret.length >= MIN_SECRET_LENGTH, "env HOME_START_CODE_SECRET",
    secret.length >= MIN_SECRET_LENGTH ? "set" : `set but shorter than ${MIN_SECRET_LENGTH} chars`,
    "openssl rand -hex 32");
};

const checkExtensions = async () => {
  try {
    const rows = await prisma.$queryRaw<{ name: string; installed_version: string | null }[]>`
      SELECT name, installed_version FROM pg_available_extensions
      WHERE name IN ('postgis', 'btree_gist')`;
    const find = (name: string) => rows.find((r) => r.name === name);
    const postgis = find("postgis");
    const gist = find("btree_gist");
    report(Boolean(postgis?.installed_version), "postgis installed",
      postgis ? `installed=${postgis.installed_version ?? "no"}` : "not available",
      "CREATE EXTENSION postgis (already declared in schema.prisma)");
    report(Boolean(gist), "btree_gist available",
      gist ? `installed=${gist.installed_version ?? "no (Phase 1 installs it)"}` : "not available",
      "use a Postgres host that ships contrib extensions (Neon does)");
  } catch (error) {
    report(false, "pg_available_extensions readable", errorText(error), "check DATABASE_URL");
  }
};

/** The branch URL and host filter, from .env.homebranch first, then the env. */
const branchTarget = () => {
  const file = fs.existsSync(BRANCH_ENV_FILE)
    ? dotenv.parse(fs.readFileSync(BRANCH_ENV_FILE))
    : {};
  const url = file.DIRECT_URL || file.DATABASE_URL;
  const host = (file.HOME_CHECK_BRANCH_HOST || process.env.HOME_CHECK_BRANCH_HOST || "").trim();
  return { url, host };
};

const checkGistSmoke = async () => {
  const label = "btree_gist exclusion smoke test";
  if (!process.argv.includes("--with-ddl")) {
    return info(`${label} skipped (run on the test branch: npm run home:check -- --with-ddl)`);
  }
  const { url, host } = branchTarget();
  if (!url) {
    return report(false, label, ".env.homebranch has no DIRECT_URL / DATABASE_URL",
      "put the Neon branch URL in .env.homebranch");
  }
  let urlHost = "";
  try {
    urlHost = new URL(url).hostname;
  } catch {
    return report(false, label, "branch URL does not parse");
  }
  if (!host || !urlHost.includes(host)) {
    return info(`${label} skipped (HOME_CHECK_BRANCH_HOST ${host ? "does not match the branch URL" : "missing"}; run on the test branch)`);
  }

  const client = new PrismaClient({ datasources: { db: { url } } });
  try {
    await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS btree_gist");
      await tx.$executeRawUnsafe(
        "CREATE TEMP TABLE home_check_gist (e text, r tstzrange, EXCLUDE USING gist (e WITH =, r WITH &&))",
      );
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    const rolledBack = error instanceof Error && error.message === ROLLBACK;
    report(rolledBack, label, rolledBack ? "created and rolled back" : errorText(error),
      "the branch role needs CREATE on the database");
  } finally {
    await client.$disconnect();
  }
};

const checkDocsPreset = async () => {
  const name = config.homeService.docsPreset;
  const { cloud_name, api_key, api_secret } = config.cloudinary;
  if (!cloud_name || !api_key || !api_secret) {
    return report(false, `upload preset "${name}"`, "Cloudinary credentials missing",
      "set CLOUDINARY_CLOUD_NAME / _API_KEY / _API_SECRET");
  }
  try {
    const preset = (await cloudinary.api.upload_preset(name)) as {
      unsigned?: boolean;
      settings?: {
        type?: string;
        folder?: string;
        // dynamic-folder accounts store the console's "Asset folder" here
        asset_folder?: string;
        allowed_formats?: string;
        max_file_size?: number;
      };
    };
    report(true, `upload preset "${name}" exists`);
    report(preset.unsigned === false, "docs preset is signed", `unsigned=${preset.unsigned}`,
      "Cloudinary console → Upload presets → Signing mode: Signed");
    report(preset.settings?.type === "authenticated", "docs preset delivery type is authenticated",
      `type=${preset.settings?.type ?? "upload (default)"}`,
      "Cloudinary console → preset → Delivery type: Authenticated");
    const s = preset.settings ?? {};
    info(`docs preset folder=${s.asset_folder ?? s.folder ?? "-"} formats=${s.allowed_formats ?? "-"} max_file_size=${s.max_file_size ?? "not reported (Phase 4 enforces 8 MB)"}`);
  } catch (error) {
    report(false, `upload preset "${name}" exists`, errorText(error),
      `create "${name}" in the Cloudinary console (signed, authenticated, folder home-experts/)`);
  }
};

const checkSettings = async () => {
  try {
    const value = await getSetting("booking.commissionPercent");
    const rows = await prisma.platformSetting.count();
    report(typeof value === "number", "settings registry readable",
      `booking.commissionPercent=${value}, ${rows} stored row(s)`);
  } catch (error) {
    report(false, "settings registry readable", errorText(error), "check DATABASE_URL and migrations");
  }
};

const printCounts = async () => {
  try {
    const salons = await prisma.salon.groupBy({
      by: ["audience"],
      where: { isDeleted: false },
      _count: { _all: true },
    });
    const bySalon = salons.map((s) => `${s.audience}=${s._count._all}`).join(" ");
    info(`salons by audience (not deleted): ${bySalon || "none"}`);

    const staff = await prisma.staff.findMany({
      where: { isDeleted: false, salon: { status: "ACTIVE", isDeleted: false } },
      select: { user: { select: { gender: true } } },
    });
    const byGender: Record<string, number> = { MALE: 0, FEMALE: 0, OTHER: 0, null: 0 };
    for (const s of staff) byGender[s.user.gender ?? "null"] += 1;
    info(`staff of ACTIVE salons by gender: ${Object.entries(byGender).map(([k, v]) => `${k}=${v}`).join(" ")} (total ${staff.length})`);
  } catch (error) {
    info(`counts unavailable: ${errorText(error)}`);
  }
};

const main = async () => {
  configureCloudinary();

  console.log("Home Service pre-flight\n");
  checkSecret();
  await checkExtensions();
  await checkGistSmoke();
  await checkDocsPreset();
  await checkSettings();
  await printCounts();

  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
  // exitCode, not process.exit(): exiting while sockets are still closing
  // trips a libuv assertion on Windows (UV_HANDLE_CLOSING).
  process.exitCode = failures ? 1 : 0;
};

main()
  .catch((error) => {
    console.error("home:check crashed:", errorText(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
