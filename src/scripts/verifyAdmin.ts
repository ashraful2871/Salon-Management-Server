/**
 * Checks for the admin access layer.
 *
 *   npm run verify:admin
 *
 * (a) role -> permission matrix against the agreed table, (b) every permission
 * string used by a route exists, (d) normalizeArea - none of these touch the
 * database. (c) needs DATABASE_URL: inside a transaction that is always rolled
 * back, an audit row is inserted and an UPDATE of it must fail. (e) the real
 * guards in-process: every role × permission cell, 2FA, adminOnly, role
 * schema, setting bounds, /events allow-list, view-as tokens. (f) read-only
 * on the database: agent scope, step-up, last SUPER_ADMIN, ledger zero-sum,
 * wallet drift, rollup vs live SQL. Exits 1 on any
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

// ---------------------------------------------------------------- (e)
// The real middleware and validators, called in-process with a fake request.
// No database: req.admin is preset, and the impersonation checks refuse
// before any query.

type Mw = (req: any, res: any, next: (err?: unknown) => void) => unknown;
const runMw = (mw: Mw, req: Record<string, unknown>) =>
  new Promise<{ statusCode?: number; errorCode?: string } | null>((resolve) => {
    const headers = (req.headers ?? {}) as Record<string, string>;
    void mw(
      { path: "/", method: "GET", cookies: {}, headers, get: (h: string) => headers[h.toLowerCase()], ...req },
      {},
      (err?: unknown) => resolve((err as { statusCode?: number; errorCode?: string }) ?? null),
    );
  });

const guardChecks = async () => {
  console.log("\n(e) guards, in-process");
  const { adminAuth, adminOnly } = await import("../app/modules/Admin/admin.middleware");
  const { rejectImpersonation, guardImpersonation } = await import("../app/utils/impersonation");
  const { UserValidation } = await import("../app/modules/User/user.validation");
  const { SETTINGS } = await import("../app/utils/settings");
  const { eventRows } = await import("../app/modules/Analytics/analytics.events");
  const jwt = (await import("jsonwebtoken")).default;

  const ctxFor = (accountRole: "ADMIN" | "AGENT", adminRole: string | undefined, permissions: readonly string[]) => ({
    userId: "verify",
    accountRole,
    adminRole,
    permissions: [...permissions],
    mfaEnabled: true,
    area: accountRole === "AGENT" ? "Mirpur 10" : undefined,
  });

  let cells = 0;
  const wrong: string[] = [];
  const bundles: Array<[string, ReturnType<typeof ctxFor>]> = [
    ...Object.entries(ADMIN_ROLE_PERMISSIONS).map(
      ([role, perms]) => [role, ctxFor("ADMIN", role, perms)] as [string, ReturnType<typeof ctxFor>],
    ),
    ["AGENT", ctxFor("AGENT", undefined, AGENT_PERMISSIONS)],
  ];
  for (const [role, ctx] of bundles) {
    for (const perm of ALL_PERMISSIONS) {
      const err = await runMw(adminAuth(perm) as Mw, { admin: ctx });
      const allowed = ctx.permissions.includes(perm);
      cells++;
      if (allowed ? err !== null : err?.statusCode !== 403) wrong.push(`${role}×${perm}`);
    }
  }
  check(`role × permission: ${cells} cells allowed/403 as the bundles say`, wrong.length === 0, wrong.slice(0, 5).join(", "));

  const noMfa = await runMw(adminAuth() as Mw, { admin: { ...bundles[0][1], mfaEnabled: false } });
  check("no 2FA → TWO_FACTOR_SETUP_REQUIRED", noMfa?.errorCode === "TWO_FACTOR_SETUP_REQUIRED");
  const agentOnly = await runMw(adminOnly as Mw, { admin: ctxFor("AGENT", undefined, AGENT_PERMISSIONS) });
  check("adminOnly refuses an AGENT (403)", agentOnly?.statusCode === 403);

  const roleBody = (role: string) => UserValidation.updateUserRoleValidation.safeParse({ body: { role } }).success;
  check("role change to ADMIN refused by validation (400)", !roleBody("ADMIN") && !roleBody("AGENT") && roleBody("STAFF"));

  const commission = SETTINGS["booking.commissionPercent"].schema;
  check("setting out of bounds refused (400)", !commission.safeParse(31).success && !commission.safeParse(-1).success && commission.safeParse(10).success);
  const badDefaults = Object.entries(SETTINGS).filter(([, e]) => !(e as any).schema.safeParse((e as any).default).success);
  check("every setting default is within its own bounds", badDefaults.length === 0, badDefaults.map(([k]) => k).join(", "));

  check(
    "junk /events dropped",
    eventRows("drop_table", "") === null &&
      eventRows("page_view", "page:../../etc,ref:x") === null &&
      eventRows("page_view", "x".repeat(200)) === null &&
      eventRows({}, "") === null,
  );

  // Signed with a throwaway secret: rejectImpersonation only decodes.
  const impToken = jwt.sign({ userId: "u", role: "CUSTOMER", imp: { adminId: "a", until: Date.now() + 60_000 } }, "verify-only");
  const plainToken = jwt.sign({ userId: "u", role: "CUSTOMER" }, "verify-only");
  const impAdmin = await runMw(rejectImpersonation as Mw, { headers: { authorization: `Bearer ${impToken}` } });
  const plainAdmin = await runMw(rejectImpersonation as Mw, { headers: { authorization: `Bearer ${plainToken}` } });
  check("imp token on /admin/* → 403 IMPERSONATION_READ_ONLY", impAdmin?.errorCode === "IMPERSONATION_READ_ONLY");
  check("ordinary token passes the /admin impersonation gate", plainAdmin === null);
  let postCode: string | undefined;
  try {
    await guardImpersonation({ method: "POST" } as any, jwt.decode(impToken) as any, "u");
  } catch (e) {
    postCode = (e as { errorCode?: string }).errorCode;
  }
  check("imp token POST → 403 IMPERSONATION_READ_ONLY", postCode === "IMPERSONATION_READ_ONLY");
};

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

  await readOnlyChecks(prisma);
  await prisma.$disconnect();
};

// ---------------------------------------------------------------- (f)
// Read-only against whatever DATABASE_URL points at: nothing is written.

const readOnlyChecks = async (prisma: (typeof import("../app/shared/prisma"))["default"]) => {
  console.log("\n(f) scope, step-up and money invariants (database, read-only)");
  const { AdminSalonsService } = await import("../app/modules/Admin/salons/salons.service");
  const { requireStepUp } = await import("../app/modules/Admin/admin.middleware");
  const { assertAnotherSuperAdmin } = await import("../app/modules/Admin/team/team.service");
  const { WalletService } = await import("../app/modules/Wallet/wallet.service");
  const { SettlementService } = await import("../app/modules/Settlement/settlement.service");

  // Agent scope (the data spells it "Mirpur"): an agent for Mirpur sees a Mirpur salon, not a Dhanmondi one.
  const salonIn = (area: string) =>
    prisma.salon.findFirst({ where: { isDeleted: false, area: { equals: area, mode: "insensitive" } }, select: { id: true } });
  const [mirpur, dhanmondi] = await Promise.all([salonIn("Mirpur"), salonIn("Dhanmondi")]);
  const agent = { userId: "verify", accountRole: "AGENT" as const, area: "Mirpur", permissions: [...AGENT_PERMISSIONS], mfaEnabled: true };
  const statusOf = async (id: string) => {
    try {
      await AdminSalonsService.getSalon(agent, id);
      return 200;
    } catch (e) {
      return (e as { statusCode?: number }).statusCode ?? 500;
    }
  };
  if (mirpur && dhanmondi) {
    check("agent (Mirpur) on a Mirpur salon → 200", (await statusOf(mirpur.id)) === 200);
    check("agent (Mirpur) on a Dhanmondi salon → 404", (await statusOf(dhanmondi.id)) === 404);
  } else {
    check("salons in Mirpur and Dhanmondi exist", false, "seed data missing; agent scope not checked");
  }

  // Step-up: a real admin with 2FA and a closed window, no code header.
  const closed = await prisma.userMfa.findFirst({
    where: {
      enabledAt: { not: null },
      OR: [{ stepUpUntil: null }, { stepUpUntil: { lt: new Date() } }],
      user: { role: "ADMIN", isDeleted: false },
    },
    select: { userId: true },
  });
  if (closed) {
    const err = await runMw(requireStepUp() as Mw, { user: { userId: closed.userId, role: "ADMIN" } });
    check("tier 3 without step-up → STEP_UP_REQUIRED", err?.errorCode === "STEP_UP_REQUIRED");
  } else {
    console.log("      skip  step-up: no admin with 2FA and a closed window right now");
  }
  check("non-staff pass requireStepUp untouched", (await runMw(requireStepUp() as Mw, { user: { userId: "c", role: "SALON_OWNER" } })) === null);

  // Last SUPER_ADMIN: demote/remove/suspend all go through this guard.
  const supers = await prisma.admin.findMany({
    where: { adminRole: "SUPER_ADMIN", user: { role: "ADMIN", status: "ACTIVE", isDeleted: false } },
    select: { userId: true },
  });
  if (supers.length === 1) {
    let code: number | undefined;
    try {
      await assertAnotherSuperAdmin(prisma, supers[0].userId, "SUPER_ADMIN");
    } catch (e) {
      code = (e as { statusCode?: number }).statusCode;
    }
    check("the last SUPER_ADMIN cannot be demoted/removed/suspended (409)", code === 409);
  } else {
    console.log(`      skip  last SUPER_ADMIN: ${supers.length} active, the guard only bites at 1`);
  }

  const [unbalanced, drift] = await Promise.all([
    SettlementService.findUnbalancedAppointments(),
    WalletService.findDrift(),
  ]);
  check("every appointment's ledger sums to 0", unbalanced.length === 0, `${unbalanced.length} unbalanced`);
  check("no wallet drift", drift.length === 0, `${drift.length} wallet(s) drift (P8: 1 known, pre-existing)`);

  // Rollup vs live SQL for the latest closed day (≥ 2 Dhaka days back).
  const DAY_SQL = `to_char((COALESCE(a."completedAt", a."appointmentDate") AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD')`;
  const [row] = await prisma.$queryRawUnsafe<Array<{ day: string; value: number }>>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, value FROM metric_daily
     WHERE metric = 'bookings.completed' AND dimension = '*'
       AND day <= ((now() AT TIME ZONE 'Asia/Dhaka')::date - 2)
     ORDER BY day DESC LIMIT 1`,
  );
  if (row) {
    const [live] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM appointments a
       JOIN salons s ON s.id = a."salonId" JOIN users u ON u.id = a."customerId"
       WHERE a.status = 'COMPLETED' AND ${DAY_SQL} = $1`,
      row.day,
    );
    check(`rollup = live SQL for ${row.day} (bookings.completed, with test data)`, live.n === row.value, `${row.value} vs ${live.n}`);
  } else {
    console.log("      skip  rollup: no closed day with completed bookings");
  }
};

guardChecks()
  .then(() => dbChecks())
  .catch((e) => {
    failed++;
    console.log(`FAIL  database checks - ${(e as Error).message.split("\n")[0]}`);
  })
  .finally(() => {
    console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
    process.exit(failed ? 1 : 0);
  });
