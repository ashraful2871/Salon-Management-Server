/**
 * `npm run verify:referral`: proves the referral program before any UI exists
 * (Phase 7): rules, attach, fraud, races, salon + home lifecycles, money,
 * caps, jobs, kill switches and access.
 *
 *   npm run verify:referral                 # test branch from .env.homebranch
 *   HOME_BRANCH_FILE=<file> npm run verify:referral   # another branch file of that shape
 *
 * 1. The pure part runs anywhere: the `referral:math` table and the access
 *    matrix's route coverage.
 * 2. Everything else runs only on the test database (`verifyReferral.env.ts`:
 *    the URL must contain HOME_CHECK_BRANCH_HOST, else Prisma is pointed at a
 *    dead address). Fixtures are isTest rows on
 *    `ref-verify.<key>.<tag>@seed.example.com`, removed at the end (also on
 *    failure); settings changed for a case are put back.
 *
 * Exit codes: 0 all ✅ · 1 any ❌ · 2 pure part green but the test branch is
 * missing or unreachable (never reported as a pass).
 */
import { branch, onHomeBranch } from "./verifyReferral.env"; // first: picks the database
import config from "../config";
import prisma from "../app/shared/prisma";
import { runMathTable } from "./referralMathCheck";
import { checkCoverage, runAccess } from "./verifyReferral.access";
import { runFlows } from "./verifyReferral.flows";
import { TAG, buildWorld, removeFixtures, restoreSettings, setSettings, type Check } from "./verifyReferral.fixtures";

let passed = 0;
let failed = 0;
const check: Check = (name, ok, detail = "") => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? `  · ${detail}` : ""}`);
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message.split("\n").filter(Boolean).pop() ?? e.message : String(e));

/** The settings every case starts from (the contract defaults, plus home commission so it is not 0). */
const BASELINE = {
  "referral.enabled": true,
  "referral.redemptionsEnabled": true,
  "referral.refereePercent": 5,
  "referral.refereeMaxDiscountMinor": 30000,
  "referral.refereeValidDays": 30,
  "referral.refereeScope": "ALL",
  "referral.referrerPercent": 10,
  "referral.referrerMaxDiscountMinor": 50000,
  "referral.referrerValidDays": 90,
  "referral.referrerScope": "SALON",
  "referral.referrerTrigger": "FIRST_BOOKING_COMPLETED",
  "referral.minOrderMinor": 0,
  "referral.qualifyWindowDays": 60,
  "referral.maxRewardsPerMonth": 10,
  "referral.maxRewardsLifetime": 50,
  "referral.restoreOnCancel": true,
  "referral.restoreOnNoShow": false,
  "referral.holdFlagged": true,
  "referral.velocityPerDay": 5,
  "booking.depositsEnabled": false,
  "booking.commissionPercent": 10,
  "homeService.enabled": true,
  "homeService.ladiesEnabled": true,
  "homeService.commissionPercent": 10,
  "homeService.minOrderEnabled": false,
} as const;

const finish = async (code: number, line: string) => {
  console.log(`\n${line}`);
  console.log(`verify:referral: ${passed} ✅, ${failed} ❌ (${passed + failed} checks)`);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(code);
};

const main = async () => {
  console.log("\n1. Rules (pure: the referral:math table)");
  runMathTable(
    (name, got, want) => {
      const ok = JSON.stringify(got) === JSON.stringify(want);
      check(`math: ${name}`, ok, ok ? "" : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    },
    (title) => console.log(`  — ${title}`),
  );
  console.log("\nAccess matrix coverage (pure)");
  checkCoverage(check);
  const pureFailed = failed > 0;

  if (!onHomeBranch) {
    return finish(
      pureFailed ? 1 : 2,
      `INCOMPLETE: no test branch (${branch.exists ? "its URL does not contain HOME_CHECK_BRANCH_HOST" : `${branch.file} not found`}); ran the pure part only.`,
    );
  }
  const url = process.env.DATABASE_URL ?? "";
  if (!branch.host || !url.includes(branch.host)) {
    check("database URL is the test branch", false, "refusing to run");
    return finish(1, "REFUSED: DATABASE_URL is not the test branch.");
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (e) {
    return finish(pureFailed ? 1 : 2, `INCOMPLETE: test branch unreachable (${branch.host}): ${errMsg(e)}. Ran the pure part only.`);
  }
  console.log(`\nTest database: ${branch.host} · fixtures tag ${TAG}`);
  const [{ table }] = await prisma.$queryRaw<Array<{ table: string | null }>>`SELECT to_regclass('public.referral_rewards')::text AS "table"`;
  check("test database has the referral tables (Phase 1 migration)", !!table);
  check("REFERRAL_HASH_SECRET is set", !!config.referral.hashSecret);
  check("AUTH_OTP_SECRET is set (the sign-up code step)", (config.auth.otpSecret ?? "").length >= 32);
  if (!table || !config.referral.hashSecret || (config.auth.otpSecret ?? "").length < 32) return finish(1, "FAILED: the test database or the env is not ready.");

  const [{ now }] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
  try {
    await setSettings(BASELINE);
    const world = await buildWorld();
    const flows = await runFlows(check, world, now);
    console.log("\n7.2 Access matrix");
    if (flows.access) await runAccess(check, world, flows.access);
    else check("access: the salon section left its fixtures", false);
  } catch (e) {
    check("verify:referral ran to the end", false, errMsg(e));
  } finally {
    // Let after-commit notices and metrics (1.5 s) land before their rows go.
    await new Promise((r) => setTimeout(r, 2500));
    const restored = await restoreSettings().then(
      () => null,
      (e) => errMsg(e),
    );
    const left = await removeFixtures();
    console.log(left.length ? `\nnote: fixtures left on the test database (tag ${TAG}): ${left.join("; ")}` : `\nfixtures removed (tag ${TAG})`);
    if (restored) console.log(`note: settings not restored: ${restored}`);
  }
  return finish(failed ? 1 : 0, failed ? "FAILED" : "PASSED");
};

void main().catch(async (e) => {
  check("verify:referral crashed", false, errMsg(e));
  await finish(1, "FAILED");
});
