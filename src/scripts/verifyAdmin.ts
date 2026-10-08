/**
 * Checks for the admin access layer.
 *
 *   npm run verify:admin
 *
 * (a) role -> permission matrix against the agreed table, (b) every permission
 * string used by a route exists, (d) normalizeArea - none of these touch the
 * database. (c) needs DATABASE_URL: inside a transaction that is always rolled
 * back, an audit row is inserted and an UPDATE of it must fail. Exits 1 on any
 * FAIL. Nothing secret is printed.
 */
import "../config"; // loads .env
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import {
  ADMIN_ROLE_PERMISSIONS,
  AGENT_PERMISSIONS,
  ALL_PERMISSIONS,
  isPermission,
  normalizeArea,
} from "../app/modules/Admin/admin.permissions";

let failed = 0;

const check = (name: string, ok: boolean, detail?: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` - ${detail}` : ""}`);
};

// ---------------------------------------------------------------- (a)

const EXPECTED: Record<string, string> = {
  SUPER_ADMIN: ALL_PERMISSIONS.join(" "),
  OPERATIONS:
    "users.view users.view_pii users.manage users.role users.impersonate salons.view salons.review salons.manage bookings.view bookings.manage appeals.resolve finance.view finance.reconcile reviews.moderate support.view support.reply support.assign content.manage analytics.view analytics.export settings.view flags.manage system.view system.operate audit.view agents.manage",
  FINANCE:
    "users.view users.view_pii salons.view bookings.view finance.view finance.payouts finance.refunds finance.wallet_adjust finance.wallet_freeze finance.reconcile finance.export analytics.view analytics.export settings.view system.view audit.view",
  SUPPORT:
    "users.view users.view_pii users.manage users.impersonate salons.view bookings.view bookings.manage appeals.resolve support.view support.reply support.assign",
  MODERATOR: "users.view users.manage salons.view bookings.view reviews.moderate support.view",
  ANALYST:
    "users.view salons.view bookings.view finance.view analytics.view analytics.export settings.view system.view",
};

const FULL_LIST =
  "users.view users.view_pii users.manage users.role users.delete users.impersonate salons.view salons.review salons.manage salons.delete bookings.view bookings.manage appeals.resolve finance.view finance.payouts finance.refunds finance.wallet_adjust finance.wallet_freeze finance.reconcile finance.export reviews.moderate support.view support.reply support.assign content.manage analytics.view analytics.export settings.view flags.manage settings.manage system.view system.operate audit.view agents.manage team.manage";

const sorted = (s: string | readonly string[]) =>
  [...(typeof s === "string" ? s.split(" ") : s)].sort().join(" ");

console.log("\n(a) role -> permissions");
check("permission union matches the full list", sorted(ALL_PERMISSIONS) === sorted(FULL_LIST));
for (const [role, perms] of Object.entries(ADMIN_ROLE_PERMISSIONS)) {
  console.log(`      ${role.padEnd(11)} ${perms.length.toString().padStart(2)}  ${perms.join(", ")}`);
  check(`${role} matches the table`, sorted(perms) === sorted(EXPECTED[role] ?? ""));
}
check("no extra roles", Object.keys(ADMIN_ROLE_PERMISSIONS).sort().join() === Object.keys(EXPECTED).sort().join());
check("AGENT = salons.view + salons.review", sorted(AGENT_PERMISSIONS) === "salons.review salons.view");

// ---------------------------------------------------------------- (b)

console.log("\n(b) permission strings used in src/app");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });

const CALL = /(?:adminAuth|assertAdminPermission|asAdmin|can)\(([^)]*)\)/g;
const STRING = /["']([a-z_]+\.[a-z_]+)["']/g;
const used = new Map<string, string>();
for (const file of walk(join(__dirname, "..", "app"))) {
  const src = readFileSync(file, "utf8");
  for (const call of src.matchAll(CALL)) {
    for (const s of call[1].matchAll(STRING)) used.set(s[1], file);
  }
}
const unknown = [...used.keys()].filter((p) => !isPermission(p));
check(`${used.size} distinct permissions referenced, all known`, unknown.length === 0, unknown.join(", "));

// ---------------------------------------------------------------- (d)

console.log("\n(d) normalizeArea");
check("trims and lowercases", normalizeArea("  Dhanmondi ") === "dhanmondi");
check("case-insensitive match", normalizeArea("GULSHAN") === normalizeArea("gulshan"));
check("inner spaces kept", normalizeArea("Mirpur 10") === "mirpur 10");
check("different areas differ", normalizeArea("Uttara") !== normalizeArea("Banani"));

// ---------------------------------------------------------------- (c)

const ROLLBACK = new Error("rollback");

const dbChecks = async () => {
  console.log("\n(c) audit_logs immutability (database, rolled back)");
  if (!process.env.DATABASE_URL) {
    check("DATABASE_URL set", false, "skipped the database checks");
    return;
  }
  const { default: prisma } = await import("../app/shared/prisma");
  let inserted = false;
  let updateRefused = false;
  let deleteRefused = false;
  try {
    await prisma.$transaction(async (tx) => {
      const row = await tx.auditLog.create({
        data: { actorRole: "SYSTEM", source: "cli", action: "verify.audit", entityType: "system" },
      });
      inserted = true;
      // Savepoints so a refused statement does not abort the outer transaction.
      await tx.$executeRawUnsafe("SAVEPOINT s1");
      try {
        await tx.$executeRaw`UPDATE audit_logs SET action = 'tampered' WHERE id = ${row.id}`;
      } catch (e) {
        updateRefused = /immutable/.test(String((e as Error).message));
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT s1");
      }
      await tx.$executeRawUnsafe("SAVEPOINT s2");
      try {
        await tx.$executeRaw`DELETE FROM audit_logs WHERE id = ${row.id}`;
      } catch (e) {
        deleteRefused = /retention job/.test(String((e as Error).message));
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT s2");
      }
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) console.log(`      error: ${(e as Error).message.split("\n")[0]}`);
  }
  check("insert an audit row", inserted);
  check("UPDATE is refused by the trigger", updateRefused);
  check("DELETE without app.audit_purge is refused", deleteRefused);

  const orphans = await prisma.user.count({
    where: { role: "ADMIN", isDeleted: false, admin: null },
  });
  check("every ADMIN user has an admins row", orphans === 0, `${orphans} without one (they get no permissions)`);
  const roles = await prisma.admin.groupBy({ by: ["adminRole"], _count: { _all: true } });
  console.log(`      admins by role: ${roles.map((r) => `${r.adminRole}=${r._count._all}`).join(", ") || "none"}`);
  await prisma.$disconnect();
};

dbChecks()
  .catch((e) => {
    failed++;
    console.log(`FAIL  database checks - ${(e as Error).message.split("\n")[0]}`);
  })
  .finally(() => {
    console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
    process.exit(failed ? 1 : 0);
  });
