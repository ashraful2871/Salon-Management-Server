/**
 * Checks for branch teams (owner Phase 10).
 *
 *   npm run verify:owner
 *
 * Everything runs inside ONE transaction that is always rolled back: owner O
 * with branches M and D, a manager MM, receptionist RM and stylist SM at M, a
 * manager MD at D, another owner X with branch XB, a customer C and a STAFF
 * account LS with no member row (pre-team behaviour). The permission matrix
 * is asserted through the salonAccess functions, then RM is removed and must
 * read 404 everywhere. Prints a table; exits 1 on any FAIL.
 */

import "../config"; // loads .env
import { randomUUID } from "crypto";
import { BranchRole, MemberStatus, Prisma, UserRole } from "@prisma/client";
import prisma from "../app/shared/prisma";
import {
  AccessUser,
  assertBookingPermission,
  assertOwnerOf,
  assertSalonPermission,
  bookingScopeWhere,
  getMyAccess,
  OwnerPermission,
} from "../app/utils/salonAccess";
import { deriveAccountRole } from "../app/modules/Team/team.service";

class Rollback extends Error {}

const rows: Array<{ check: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail = "") => rows.push({ check: name, ok, detail });

const allowed = (p: Promise<unknown>) => p.then(() => true, () => false);

type Column = { label: string; test: (u: AccessUser) => Promise<boolean> };

const run = async (tx: Prisma.TransactionClient) => {
  const tag = randomUUID().slice(0, 8);
  const user = (key: string, role: UserRole) =>
    tx.user.create({
      data: { email: `verify-owner-${key}-${tag}@seed.example.com`, name: `Verify ${key}`, role, isTest: true },
    });
  const salon = (name: string, ownerId: string) =>
    tx.salon.create({
      data: { name: `${name} ${tag}`, address: "test road", area: "Mirpur", city: "Dhaka", phone: "01700000000", images: [], ownerId, isTest: true },
    });

  const oUser = await user("o", UserRole.SALON_OWNER);
  const o = await tx.salonOwner.create({ data: { userId: oUser.id, businessName: `Verify Owner ${tag}` } });
  const M = await salon("Verify M", o.id);
  const D = await salon("Verify D", o.id);
  const xUser = await user("x", UserRole.SALON_OWNER);
  const x = await tx.salonOwner.create({ data: { userId: xUser.id, businessName: `Verify X ${tag}` } });
  const XB = await salon("Verify XB", x.id);

  const mm = await user("mm", UserRole.BRANCH_MANAGER);
  const rm = await user("rm", UserRole.BRANCH_MANAGER);
  const sm = await user("sm", UserRole.STAFF);
  const md = await user("md", UserRole.BRANCH_MANAGER);
  const c = await user("c", UserRole.CUSTOMER);
  const ls = await user("ls", UserRole.STAFF);

  const seat = (userId: string, salonId: string, role: BranchRole) =>
    tx.salonMember.create({ data: { userId, salonId, role, invitedById: oUser.id } });
  await seat(mm.id, M.id, BranchRole.MANAGER);
  const rmSeat = await seat(rm.id, M.id, BranchRole.RECEPTIONIST);
  await seat(sm.id, M.id, BranchRole.STYLIST);
  await seat(md.id, D.id, BranchRole.MANAGER);
  const smStaff = await tx.staff.create({ data: { userId: sm.id, salonId: M.id } });
  const lsStaff = await tx.staff.create({ data: { userId: ls.id, salonId: D.id } });

  const as = (u: { id: string; role: string }): AccessUser => ({ userId: u.id, role: u.role, db: tx });
  const admin: AccessUser = { userId: randomUUID(), role: UserRole.ADMIN, db: tx };

  const perm = (salonId: string, p: OwnerPermission) => (u: AccessUser) => allowed(assertSalonPermission(u, salonId, p));
  const booking = (salonId: string, staffId: string | null) => (u: AccessUser) =>
    allowed(assertBookingPermission(u, { salonId, staffId }, "bookings.manage"));

  const columns: Column[] = [
    { label: "bookM", test: perm(M.id, "bookings.view") },
    { label: "ownSM", test: booking(M.id, smStaff.id) },
    { label: "otherM", test: booking(M.id, null) },
    { label: "bookD", test: perm(D.id, "bookings.view") },
    { label: "walkM", test: perm(M.id, "walkin.create") },
    { label: "slotsM", test: perm(M.id, "slots.manage") },
    { label: "policy", test: perm(M.id, "policy.manage") },
    { label: "money", test: perm(M.id, "money.view") },
    { label: "owner", test: (u) => allowed(assertOwnerOf(u)) },
    { label: "teamM", test: perm(M.id, "team.invite") },
    { label: "invMgr", test: perm(M.id, "team.invite_manager") },
    { label: "XB", test: perm(XB.id, "bookings.view") },
  ];

  // 1 = allowed, 0 = 404. Same order as `columns`.
  const matrix: Array<[string, AccessUser, string]> = [
    ["ADMIN", admin, "111111110111"],
    ["O owner", as(oUser), "111111111110"],
    ["MM mgr@M", as(mm), "111011000100"],
    ["RM rcp@M", as(rm), "111010000000"],
    ["SM sty@M", as(sm), "110000000000"],
    ["MD mgr@D", as(md), "000100000000"],
    ["X owner", as(xUser), "000000001001"],
    ["C cust", as(c), "000000000000"],
    ["LS legacy@D", as(ls), "000100000000"],
  ];

  const table: string[] = [`${"actor".padEnd(12)} ${columns.map((col) => col.label.padStart(6)).join(" ")}`];
  for (const [name, actor, expected] of matrix) {
    const got = await Promise.all(columns.map((col) => col.test(actor)));
    const cells = got.map((ok, i) => {
      const want = expected[i] === "1";
      check(`${name} ${columns[i].label}`, ok === want, `want ${want ? "allow" : "404"}, got ${ok ? "allow" : "404"}`);
      return `${ok ? "ok" : "404"}${ok === want ? "" : "!"}`.padStart(6);
    });
    table.push(`${name.padEnd(12)} ${cells.join(" ")}`);
  }

  // A stylist's list is their own bookings only; the legacy staff the same.
  const smScope = await bookingScopeWhere(as(sm), "bookings.view");
  check("SM list scope = own bookings at M", JSON.stringify(smScope) === JSON.stringify({ salonId: M.id, staffId: smStaff.id }), JSON.stringify(smScope));
  const lsScope = await bookingScopeWhere(as(ls), "bookings.view");
  check("LS list scope = own bookings at D", JSON.stringify(lsScope) === JSON.stringify({ salonId: D.id, staffId: lsStaff.id }), JSON.stringify(lsScope));
  check("MM asking for D → nothing", (await bookingScopeWhere(as(mm), "bookings.view", D.id)) === null);
  check("MM services.edit off by default", !(await allowed(assertSalonPermission(as(mm), M.id, "services.edit"))));
  await tx.salon.update({ where: { id: M.id }, data: { managerCanEditServices: true } });
  check("MM services.edit when the owner allows it", await allowed(assertSalonPermission(as(mm), M.id, "services.edit")));
  check("RM services.edit never", !(await allowed(assertSalonPermission(as(rm), M.id, "services.edit"))));

  const mmAccess = await getMyAccess(as(mm));
  check("getMyAccess(MM) = [M as MANAGER]", mmAccess.length === 1 && mmAccess[0].salonId === M.id && mmAccess[0].role === "MANAGER");
  check("getMyAccess(MM) has no owner-only permission", !mmAccess[0].permissions.some((p) => ["money.view", "policy.manage", "branch.location", "branch.create", "team.invite_manager"].includes(p)));

  // Account roles.
  const roles: Array<[string, string, UserRole]> = [
    ["O", oUser.id, UserRole.SALON_OWNER],
    ["MM", mm.id, UserRole.BRANCH_MANAGER],
    ["RM", rm.id, UserRole.BRANCH_MANAGER],
    ["SM", sm.id, UserRole.STAFF],
    ["C", c.id, UserRole.CUSTOMER],
  ];
  for (const [name, id, want] of roles) {
    const got = await deriveAccountRole(tx, id);
    check(`deriveAccountRole(${name}) = ${want}`, got === want, got);
  }

  // Removed (and suspended) members read 404 everywhere.
  await tx.salonMember.update({ where: { id: rmSeat.id }, data: { status: MemberStatus.REMOVED, removedAt: new Date() } });
  const rmAfter = as(rm);
  const rmAny = await Promise.all(columns.map((col) => col.test(rmAfter)));
  check("RM removed → 404 everywhere", rmAny.every((ok) => !ok), rmAny.map((ok) => (ok ? 1 : 0)).join(""));
  check("RM removed → getMyAccess empty", (await getMyAccess(rmAfter)).length === 0);
  check("RM removed → list scope nothing", (await bookingScopeWhere(rmAfter, "bookings.view")) === null);
  check("deriveAccountRole(RM removed) = CUSTOMER", (await deriveAccountRole(tx, rm.id)) === UserRole.CUSTOMER);

  await tx.salonMember.updateMany({ where: { userId: mm.id }, data: { status: MemberStatus.SUSPENDED } });
  check("MM suspended → 404 at M", !(await allowed(assertSalonPermission(as(mm), M.id, "bookings.view"))));

  // A deleted branch drops out for members too.
  await tx.salon.update({ where: { id: D.id }, data: { isDeleted: true } });
  check("MD at a deleted branch → 404", !(await allowed(assertSalonPermission(as(md), D.id, "bookings.view"))));

  console.log(table.join("\n"));
  console.log("");
  throw new Rollback();
};

const main = async () => {
  try {
    await prisma.$transaction(run, { timeout: 120_000, maxWait: 15_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) {
      check("scenario ran to the end", false, error instanceof Error ? error.message : String(error));
    }
  }

  const failed = rows.filter((row) => !row.ok);
  const width = Math.max(...rows.map((row) => row.check.length));
  for (const row of failed) console.log(`FAIL  ${row.check.padEnd(width)}  ${row.detail}`);
  console.log(`verify:owner ${failed.length ? "FAILED" : "passed"}: ${rows.length - failed.length}/${rows.length} (rolled back)`);
  await prisma.$disconnect();
  process.exit(failed.length ? 1 : 0);
};

void main();
