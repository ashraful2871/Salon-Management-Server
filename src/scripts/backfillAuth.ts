/**
 * Gets the users who signed up before one-time codes existed past the
 * verification gate, before REQUIRE_EMAIL_VERIFICATION is turned on - against
 * the real database.
 *
 *   npm run auth:backfill              dry run: SELECTs only, prints the plan
 *   npm run auth:backfill -- --apply   writes, both steps in one transaction
 *
 * 1. Marks every unverified user who is not deleted as verified (D1), so the
 *    flag does not send existing accounts to the code screen.
 * 2. Trims and lower-cases emails - unless two rows would collide on the
 *    unique email column, in which case the step is skipped for a manual fix.
 *    Duplicates are grouped on lower(trim(email)), the same expression the
 *    update writes, so it finds every group lower(email) would and more.
 *
 * Prints counts and roles only, never an email or an id. Both steps are
 * idempotent: a second --apply changes 0 rows.
 */
import { Prisma } from "@prisma/client";
import prisma from "../app/shared/prisma";

type Db = Prisma.TransactionClient;
type RoleCount = { role: string; count: bigint };
type CountRow = { count: bigint };
type Snapshot = { unverified: RoleCount[]; duplicates: number; notNormalised: number };

/** Set once the transaction commits, so a later failure is not reported as a rollback. */
let committed = false;

/** Prisma's connection errors name the host; keep that out of pasted output. */
const redact = (message: string) =>
  message
    .replace(/postgres(ql)?:\/\/\S+/gi, "<database url>")
    .replace(/`[^`\s]+:\d+`/g, "`<host>`");

const unverifiedByRole = (db: Db) =>
  db.$queryRaw<RoleCount[]>`
    SELECT role::text AS role, count(*) AS count
    FROM users
    WHERE "emailVerified" = false AND "isDeleted" = false
    GROUP BY role
    ORDER BY role`;

// Deleted rows included: the unique index on email covers them too.
const duplicateGroups = async (db: Db) => {
  const [row] = await db.$queryRaw<CountRow[]>`
    SELECT count(*) AS count FROM (
      SELECT 1 FROM users GROUP BY lower(trim(email)) HAVING count(*) > 1
    ) AS collisions`;
  return Number(row.count);
};

const notNormalisedEmails = async (db: Db) => {
  const [row] = await db.$queryRaw<CountRow[]>`
    SELECT count(*) AS count FROM users WHERE email <> lower(trim(email))`;
  return Number(row.count);
};

const snapshot = async (db: Db): Promise<Snapshot> => ({
  unverified: await unverifiedByRole(db),
  duplicates: await duplicateGroups(db),
  notNormalised: await notNormalisedEmails(db),
});

const total = (rows: RoleCount[]) => rows.reduce((sum, row) => sum + Number(row.count), 0);

const printSnapshot = (title: string, state: Snapshot) => {
  console.log(`\n== ${title}`);
  console.log(`unverified users (not deleted):          ${total(state.unverified)}`);
  state.unverified.forEach((row) =>
    console.log(`  ${row.role.padEnd(12)} ${Number(row.count)}`),
  );
  console.log(`email duplicate groups (trim + lower):   ${state.duplicates}`);
  console.log(`emails not already trimmed + lower-case: ${state.notNormalised}`);
};

const skipLowerCase = (duplicates: number) =>
  `skipped - resolve ${duplicates} duplicates by hand first`;

const main = async () => {
  const apply = process.argv.includes("--apply");
  const before = await snapshot(prisma);

  if (!apply) {
    printSnapshot("Dry run (pass --apply to write)", before);
    console.log("\n== Plan");
    console.log(`1. mark verified:  ${total(before.unverified)} user(s)`);
    console.log(
      `2. lower-case:     ${
        before.duplicates > 0
          ? skipLowerCase(before.duplicates)
          : `${before.notNormalised} email(s)`
      }`,
    );
    await prisma.$disconnect();
    return;
  }

  printSnapshot("Before", before);

  // The duplicate check runs inside the transaction, so the lower-case update
  // is decided on the same data it writes.
  const result = await prisma.$transaction(
    async (tx) => {
      const verified = await tx.$executeRaw`
        UPDATE users
        SET "emailVerified" = true, "emailVerifiedAt" = now()
        WHERE "emailVerified" = false AND "isDeleted" = false`;
      const duplicates = await duplicateGroups(tx);
      const lowered =
        duplicates > 0
          ? null
          : await tx.$executeRaw`
              UPDATE users SET email = lower(trim(email))
              WHERE email <> lower(trim(email))`;
      return { verified, duplicates, lowered };
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
  committed = true;

  console.log("\n== Applied (one transaction, committed)");
  console.log(`1. marked verified: ${result.verified} user(s)`);
  console.log(
    `2. lower-cased:     ${
      result.lowered === null ? skipLowerCase(result.duplicates) : `${result.lowered} email(s)`
    }`,
  );

  printSnapshot("After", await snapshot(prisma));
  await prisma.$disconnect();
};

main().catch(async (error) => {
  console.error(
    committed
      ? "\nauth:backfill committed its writes, then failed reading the after counts:"
      : "\nauth:backfill failed - nothing was written:",
  );
  console.error(redact(String(error?.message ?? error)));
  await prisma.$disconnect();
  process.exit(1);
});
