/**
 * Phase 7.2 of `verify:referral`: every `/referrals/*` and `/admin/referrals/*`
 * route × every role, through real HTTP on the real app.
 *
 * `checkCoverage` runs anywhere (no database): a route added without a row
 * here fails. `runAccess` needs committed rows, so it runs only on the test
 * database (the caller has already refused anything else).
 *
 * A cell expects one of:
 *   ok        2xx
 *   401, 403, 404
 *   403:CODE  that status with that errorCode.
 *
 * Writes by an admin stop at the step-up (403:STEP_UP_REQUIRED): the proof the
 * caller was let through, and that nothing changed.
 */
import { randomUUID } from "crypto";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { AdminRole, UserRole } from "@prisma/client";
import config from "../config";
import { jwtHelpers } from "../app/helper/jwtHelper";
import prisma from "../app/shared/prisma";
import { permissionsFor, type Permission } from "../app/modules/Admin/admin.permissions";
import { ReferralRoutes } from "../app/modules/Referral/referral.routes";
import { ReferralAdminRoutes } from "../app/modules/Referral/referral.admin.routes";
import { person, type Check, type World } from "./verifyReferral.fixtures";
import type { FlowResult } from "./verifyReferral.flows";

const ADMIN_ROLES = ["SUPER_ADMIN", "OPERATIONS", "FINANCE", "SUPPORT", "MODERATOR", "ANALYST"] as const;
const ROLES = ["guest", "customer", "otherCustomer", "staff", "owner", "manager", "AGENT", ...ADMIN_ROLES] as const;

type Role = (typeof ROLES)[number];
type Want = "ok" | 401 | 403 | 404 | `403:${string}`;
type Grid = Record<Role, Want>;
type Ids = { code: string; referralId: string; rewardId: string; userId: string };
type Route = {
  /** "METHOD /path" as mounted on its router; `other` rows live outside the two referral routers. */
  router: "public" | "admin" | "other";
  key: string;
  url: (f: Ids) => string;
  body?: (f: Ids) => unknown;
  grid: Grid;
};

const grid = (rest: Want, over: Partial<Grid>): Grid =>
  Object.fromEntries(ROLES.map((role) => [role, over[role] ?? rest])) as Grid;
const only = (roles: readonly Role[], want: Want): Partial<Grid> => Object.fromEntries(roles.map((r) => [r, want]));
const heldBy = (...perms: Permission[]) =>
  ADMIN_ROLES.filter((r) => {
    const has = permissionsFor("ADMIN", AdminRole[r]);
    return perms.every((p) => has.includes(p));
  });

const STEP_UP: Want = "403:STEP_UP_REQUIRED";
const PUBLIC = grid("ok", {});
const CUSTOMERS = grid("403:CUSTOMER_ONLY", { guest: 401, customer: "ok", otherCustomer: "ok" });
const adminRead = (...perms: Permission[]) => grid(403, { guest: 401, ...only(heldBy(...perms), "ok") });
const adminWrite = (...perms: Permission[]) => grid(403, { guest: 401, ...only(heldBy(...perms), STEP_UP) });

const P = "/api/v1/referrals";
const A = "/api/v1/admin/referrals";
const reason = { reason: "verify:referral access matrix" };

export const MATRIX: Route[] = [
  { router: "public", key: "GET /code/:code", url: (f) => `${P}/code/${f.code}`, grid: PUBLIC },
  { router: "public", key: "GET /me", url: () => `${P}/me`, grid: CUSTOMERS },
  { router: "public", key: "GET /me/friends", url: () => `${P}/me/friends`, grid: CUSTOMERS },
  { router: "public", key: "GET /me/rewards/summary", url: () => `${P}/me/rewards/summary`, grid: CUSTOMERS },
  { router: "public", key: "GET /me/rewards", url: () => `${P}/me/rewards`, grid: CUSTOMERS },

  { router: "admin", key: "GET /overview", url: () => `${A}/overview`, grid: adminRead("referrals.view") },
  { router: "admin", key: "GET /export", url: () => `${A}/export?type=referrals`, grid: adminRead("referrals.view", "analytics.export") },
  { router: "admin", key: "GET /rewards", url: () => `${A}/rewards`, grid: adminRead("referrals.view") },
  {
    router: "admin",
    key: "POST /rewards/grant",
    url: () => `${A}/rewards/grant`,
    body: (f) => ({ userId: f.userId, percent: 5, maxDiscountMinor: 10000, validDays: 30, scope: "ALL", ...reason }),
    grid: adminWrite("referrals.manage"),
  },
  { router: "admin", key: "POST /rewards/:id/revoke", url: (f) => `${A}/rewards/${f.rewardId}/revoke`, body: () => reason, grid: adminWrite("referrals.manage") },
  { router: "admin", key: "POST /users/:userId/code/reset", url: (f) => `${A}/users/${f.userId}/code/reset`, body: () => reason, grid: adminWrite("referrals.manage") },
  { router: "admin", key: "POST /users/:userId/block", url: (f) => `${A}/users/${f.userId}/block`, body: () => reason, grid: adminWrite("referrals.manage") },
  { router: "admin", key: "POST /users/:userId/unblock", url: (f) => `${A}/users/${f.userId}/unblock`, body: () => reason, grid: adminWrite("referrals.manage") },
  { router: "admin", key: "GET /", url: () => `${A}`, grid: adminRead("referrals.view") },
  { router: "admin", key: "GET /:id", url: (f) => `${A}/${f.referralId}`, grid: adminRead("referrals.view") },
  { router: "admin", key: "POST /:id/approve", url: (f) => `${A}/${f.referralId}/approve`, body: () => reason, grid: adminWrite("referrals.manage") },
  { router: "admin", key: "POST /:id/reject", url: (f) => `${A}/${f.referralId}/reject`, body: () => reason, grid: adminWrite("referrals.manage") },

  // The settings group `referral` (tier 3) through the admin settings route.
  {
    router: "other",
    key: "PATCH /admin/settings/referral.refereePercent",
    url: () => "/api/v1/admin/settings/referral.refereePercent",
    body: () => ({ value: 5, ...reason }),
    grid: adminWrite("referrals.policy"),
  },
];

type RouteLayer = { route?: { path: string; methods: Record<string, boolean> } };
const routesOf = (router: unknown) =>
  (router as { stack: RouteLayer[] }).stack.flatMap((layer) =>
    layer.route ? Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${layer.route!.path}`) : [],
  );

/** Every route on the two referral routers has a row, and no row is stale. */
export const checkCoverage = (check: Check) => {
  const want = (router: "public" | "admin") => new Set(MATRIX.filter((r) => r.router === router).map((r) => r.key));
  const pub = want("public");
  const adm = want("admin");
  const live = { public: routesOf(ReferralRoutes), admin: routesOf(ReferralAdminRoutes) };
  const missing = [
    ...live.public.filter((r) => !pub.has(r)).map((r) => `/referrals ${r}`),
    ...live.admin.filter((r) => !adm.has(r)).map((r) => `/admin/referrals ${r}`),
  ];
  const stale = [...[...pub].filter((r) => !live.public.includes(r)), ...[...adm].filter((r) => !live.admin.includes(r))];
  check(
    `access: matrix covers every route (${pub.size + adm.size} routes + settings × ${ROLES.length} roles)`,
    missing.length === 0 && stale.length === 0,
    [...missing, ...stale.map((r) => `stale ${r}`)].join(", "),
  );
  const view = heldBy("referrals.view").join(",");
  const manage = heldBy("referrals.manage").join(",");
  const policy = heldBy("referrals.policy").join(",");
  check(
    "access: permission bundles as the contract says",
    view === "SUPER_ADMIN,OPERATIONS,FINANCE,SUPPORT,ANALYST" && manage === "SUPER_ADMIN,OPERATIONS" && policy === "SUPER_ADMIN,FINANCE",
    `view ${view} · manage ${manage} · policy ${policy}`,
  );
};

type Hit = { status: number; code?: string; message?: string; data?: any };

const judge = (want: Want, r: Hit) => {
  if (want === "ok") return r.status >= 200 && r.status < 300;
  if (typeof want === "number") return r.status === want;
  const [status, code] = want.split(":");
  return r.status === Number(status) && r.code === code;
};

export const runAccess = async (check: Check, w: World, flows: NonNullable<FlowResult["access"]>) => {
  const { default: app } = await import("../app");
  // The limiters key on the client address; each request here is its own client.
  config.internalApiKey = config.internalApiKey || "verify-referral";
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  type Who = { id: string; email: string; role: UserRole };
  const mfa = (userId: string) => prisma.userMfa.create({ data: { userId, secretEnc: "verify", enabledAt: new Date(), recoveryCodeHashes: [] } });

  const staffUser = await person("access-staff", UserRole.STAFF);
  await prisma.staff.create({ data: { userId: staffUser.id, salonId: w.salonId } });
  const manager = await person("access-manager", UserRole.BRANCH_MANAGER);
  await prisma.salonMember.create({ data: { salonId: w.salonId, userId: manager.id, role: "MANAGER" } });
  const agent = await person("access-agent", UserRole.AGENT);
  await prisma.agent.create({ data: { userId: agent.id, division: "Dhaka", district: "Dhaka", area: "Mirpur" } });
  await mfa(agent.id);
  const admins = {} as Record<(typeof ADMIN_ROLES)[number], Who>;
  for (const r of ADMIN_ROLES) {
    const u = await person(`access-admin-${r.toLowerCase()}`, UserRole.ADMIN);
    await prisma.admin.create({ data: { userId: u.id, adminRole: AdminRole[r] } });
    await mfa(u.id);
    admins[r] = u;
  }
  const load = (id: string) => prisma.user.findUniqueOrThrow({ where: { id }, select: { id: true, email: true, role: true } });
  const users: Record<Exclude<Role, "guest">, Who> = {
    customer: await load(flows.customer),
    otherCustomer: await load(flows.otherCustomer),
    staff: staffUser,
    owner: w.owner,
    manager,
    AGENT: agent,
    ...admins,
  };
  const code = (await prisma.referralCode.findUniqueOrThrow({ where: { userId: (await prisma.referral.findUniqueOrThrow({ where: { id: flows.referralId } })).referrerId } })).code;
  const ids: Ids = { code, referralId: flows.referralId, rewardId: flows.customerRewardId, userId: flows.customer };

  const tokens = new Map<string, string>();
  const tokenOf = (u: Who) => {
    let t = tokens.get(u.id);
    if (!t) {
      t = jwtHelpers.createToken({ userId: u.id, email: u.email, role: u.role, sv: 0 }, config.jwt.jwt_secret as string, "1h");
      tokens.set(u.id, t);
    }
    return t;
  };
  let ip = 0;
  const hit = async (who: Who | null, method: string, url: string, body?: unknown): Promise<Hit> => {
    ip += 1;
    const res = await fetch(base + url, {
      method,
      headers: {
        "content-type": "application/json",
        "x-internal-key": String(config.internalApiKey),
        "x-client-ip": `10.${(ip >> 16) & 255}.${(ip >> 8) & 255}.${ip & 255}`,
        ...(who ? { authorization: `Bearer ${tokenOf(who)}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      return { status: res.status, code: json.errorCode, message: json.message, data: json.data };
    } catch {
      return { status: res.status };
    }
  };
  const as = (role: Role) => (role === "guest" ? null : users[role]);

  try {
    const failures: string[] = [];
    let cells = 0;
    for (const route of MATRIX) {
      const method = route.key.split(" ")[0];
      await Promise.all(
        ROLES.map(async (role) => {
          const url = route.url(ids);
          const r = await hit(as(role), method, url, route.body?.(ids));
          cells += 1;
          if (!judge(route.grid[role], r)) {
            failures.push(`${route.key} · ${role}: wanted ${route.grid[role]}, got ${r.status}${r.code ? ` ${r.code}` : ""}`);
          }
        }),
      );
    }
    check(`access: matrix · ${cells} cells`, failures.length === 0 && cells === MATRIX.length * ROLES.length, failures.length ? `${failures.length} wrong` : "");
    for (const line of failures) check(`access · ${line}`, false);

    // Writes stopped at the step-up: nothing moved.
    const untouched = await prisma.referralReward.findUniqueOrThrow({ where: { id: ids.rewardId } });
    const notBlocked = await prisma.referralCode.findUnique({ where: { userId: ids.userId }, select: { blockedAt: true } });
    check("access: refused / stepped-up writes changed nothing", untouched.status === "AVAILABLE" && !notBlocked?.blockedAt, `${untouched.status}`);

    // Another customer's reward, through every customer route that takes one.
    const quote = (who: Who, slotId: string, rewardId?: string | null) =>
      hit(who, "POST", "/api/v1/appointments/quote", { ...flows.slotBody(slotId), ...(rewardId !== undefined ? { rewardId } : {}) });
    const slotId = await flows.freshSlot();
    const foreign = await quote(users.otherCustomer, slotId, ids.rewardId);
    const unknown = await quote(users.otherCustomer, slotId, randomUUID());
    check(
      "access: another customer's reward on the salon quote → 404, same as an unknown id",
      foreign.status === 404 && unknown.status === 404 && foreign.message === unknown.message,
      `${foreign.status} / ${unknown.status}`,
    );
    const booked = await hit(users.otherCustomer, "POST", "/api/v1/appointments", { ...flows.slotBody(slotId), rewardId: ids.rewardId });
    check("access: … and on booking → 404, nothing booked", booked.status === 404, `${booked.status} ${booked.code ?? ""}`);
    const own = await quote(users.customer, slotId, ids.rewardId);
    check("access: the owner quoting it → 200 with it applied (control)", own.status === 200 && own.data?.promo?.rewardId === ids.rewardId, `${own.status}`);
    const usedBy = await load(flows.used.userId);
    const spent = await quote(usedBy, slotId, flows.used.rewardId);
    check("access: one's own used reward → 409 REWARD_UNAVAILABLE (not 404)", spent.status === 409 && spent.code === "REWARD_UNAVAILABLE", `${spent.status} ${spent.code ?? ""}`);

    const theirs = await hit(users.otherCustomer, "GET", `${P}/me/rewards`);
    const mine = await hit(users.customer, "GET", `${P}/me/rewards`);
    const idsIn = (r: Hit): string[] => (Array.isArray(r.data) ? r.data : (r.data?.rewards ?? r.data?.items ?? [])).map((x: { id?: string; rewardId?: string }) => x.id ?? x.rewardId ?? "");
    check(
      "access: /me/rewards lists only one's own",
      theirs.status === 200 && !idsIn(theirs).includes(ids.rewardId) && mine.status === 200 && idsIn(mine).includes(ids.rewardId),
      `other ${idsIn(theirs).length}, own ${idsIn(mine).length}`,
    );

    const lookup = await hit(null, "GET", `${P}/code/${code}`);
    const bad = await hit(null, "GET", `${P}/code/NOTACODE9`);
    check("access: public lookup → valid for a real code, valid:false for a bad one (both 200)", lookup.data?.valid === true && bad.status === 200 && bad.data?.valid === false, `${lookup.status}/${bad.status}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};
