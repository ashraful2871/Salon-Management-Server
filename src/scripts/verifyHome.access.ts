/**
 * The Phase 16 half of `verify:home`.
 *
 * Runs anywhere (no database): every Home Service route is in the matrix, and
 * the booking window through `computeSlots`.
 *
 * Runs only on a test database, because it needs committed rows: real HTTP
 * through the real app, every role × every route, the gender and window
 * refusals, 20 parallel creates, and a salon appointment racing a home booking
 * for one stylist. `runLive` refuses anything else. The fixtures are removed
 * afterwards; a failed removal is reported, not fatal.
 *
 * A cell expects one of:
 *   ok        2xx
 *   empty     2xx with no rows: a list scoped to the caller, nothing leaked
 *   through   past the gates: the service answered, even with a refusal of its
 *             own (a checklist, a wrong state). Never 401/403/404/5xx.
 *   401, 403, 404
 *   403:CODE  that status with that errorCode.
 *
 * Writes by an admin stop at the step-up (403:STEP_UP_REQUIRED), which is the
 * proof the caller was let through and that nothing changed.
 */
import { randomUUID } from "crypto";
import type { Server } from "http";
import type { AddressInfo } from "net";
import {
  AdminRole,
  AdvanceStatus,
  ExpertVerification,
  Gender,
  HomeAudience,
  HomeBookingStatus,
  HomeCategory,
  HomeServiceStatus,
  Prisma,
  SalonStatus,
  UserRole,
  WalletTxType,
} from "@prisma/client";
import app from "../app";
import config from "../config";
import { jwtHelpers } from "../app/helper/jwtHelper";
import prisma from "../app/shared/prisma";
import { permissionsFor, type Permission } from "../app/modules/Admin/admin.permissions";
import { addDays, dayStart, dhakaDay } from "../app/modules/Analytics/analytics.days";
import { computeSlots, type SlotInput } from "../app/modules/HomeService/home.availability";
import { HomeServiceAdminRoutes, HomeServiceRoutes } from "../app/modules/HomeService/home.routes";
import { currentPolicy, policySnapshotOf } from "../app/modules/HomeService/home.policy";
import { WalletService } from "../app/modules/Wallet/wallet.service";

export type Check = (name: string, ok: boolean, detail?: string) => void;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

const ADMIN_ROLES = ["SUPER_ADMIN", "OPERATIONS", "FINANCE", "SUPPORT", "MODERATOR", "ANALYST"] as const;
const ROLES = [
  "guest",
  "customer",
  "otherCustomer",
  "owner",
  "otherOwner",
  "manager",
  "expert",
  "otherExpert",
  "xExpert",
  "staff",
  ...ADMIN_ROLES,
  "AGENT",
] as const;

type Role = (typeof ROLES)[number];
type Want = "ok" | "empty" | "through" | 401 | 403 | 404 | `403:${string}`;
type Grid = Record<Role, Want>;
type Target = "booking" | "offering" | "expert";

type Fixtures = {
  salon: string;
  /** The owner's second branch: never turned on, so on / off / pause can't disturb the rest. */
  spareBranch: string;
  otherSalon: string;
  booking: string;
  offering: string;
  gentsOffering: string;
  otherOffering: string;
  expert: string;
  maleExpert: string;
  otherExpert: string;
  candidateStaff: string;
  profile: string;
  report: string;
  address: string;
  lat: number;
  lng: number;
};

type Route = {
  /** "METHOD /pattern" as mounted, or undefined for a route outside the two routers. */
  home?: string;
  admin?: string;
  other?: string;
  url: (f: Fixtures, id: string) => string;
  body?: (f: Fixtures, id: string) => unknown;
  grid: Grid;
  /** A new row for each cell that gets through, so one cell's write can't change the next. */
  fresh?: Target;
};

const grid = (rest: Want, over: Partial<Grid>): Grid =>
  Object.fromEntries(ROLES.map((role) => [role, over[role] ?? rest])) as Grid;

const only = (roles: readonly Role[], want: Want): Partial<Grid> => Object.fromEntries(roles.map((r) => [r, want]));

const PUBLIC = grid("ok", {});
const SIGNED_IN = grid("ok", { guest: 401 });
const CUSTOMER_ONLY = grid("403:HOME_SERVICE_CUSTOMER_ONLY", { guest: 401, customer: "through", otherCustomer: "through" });
const OWN_BOOKING = grid(404, { guest: 401, customer: "through" });
const ADDRESS_LIST = grid(403, { guest: 401, customer: "ok", otherCustomer: "ok" });
const ADDRESS_WRITE = grid(403, { guest: 401, customer: "through", otherCustomer: 404 });
const JOB_LIST = grid(403, { guest: 401, manager: "ok", expert: "ok", otherExpert: "ok", xExpert: "ok", staff: "ok" });
const OWN_JOB = grid(403, { guest: 401, expert: "through", otherExpert: 404, xExpert: 404, staff: 404, manager: 404 });

/** `homeservice.manage` / `homeservice.bookings`: a role gate, then salonAccess (404 outside it). */
const BRANCH = (want: Want): Grid =>
  grid(403, { guest: 401, owner: want, manager: want, otherOwner: 404, expert: 404, otherExpert: 404, xExpert: 404, staff: 404 });
/** On / off / pause: `auth("SALON_OWNER")`, so a manager stops at the role gate. */
const OWNER_SWITCH = grid(403, { guest: 401, owner: "through", otherOwner: 404 });

// From the shared contract, written out: these are the rules, not a read of the table.
const VIEW = ["SUPER_ADMIN", "OPERATIONS", "FINANCE", "SUPPORT", "ANALYST"] as const;
const MANAGE = ["SUPER_ADMIN", "OPERATIONS"] as const;
const POLICY = ["SUPER_ADMIN", "FINANCE"] as const;
const STEP_UP: Want = "403:STEP_UP_REQUIRED";

const adminRead = (roles: readonly Role[]) => grid(403, { guest: 401, ...only(roles, "ok") });
const adminWrite = (roles: readonly Role[]) => grid(403, { guest: 401, ...only(roles, STEP_UP) });
const heldBy = (permission: Permission) => ADMIN_ROLES.filter((r) => permissionsFor("ADMIN", AdminRole[r]).includes(permission));

const salonQ = (id: string) => `salonId=${id}`;
const O = "/api/v1/home-service/owner";
const H = "/api/v1/home-service";
const A = "/api/v1/admin/home-service";
const reason = { reason: "verify:home access matrix" };

const quoteBody = (f: Fixtures, startAt: Date, over: Record<string, unknown> = {}) => ({
  salonId: f.salon,
  audience: "LADIES",
  offeringIds: [f.offering],
  expertId: f.expert,
  date: dhakaDay(startAt),
  startAt: startAt.toISOString(),
  lat: f.lat,
  lng: f.lng,
  addressLine: "House 1, Road 1, Mirpur",
  recipientName: "Verify",
  recipientIsWoman: true,
  contactPhone: "01711111111",
  ...over,
});
const tomorrowTen = () => new Date(dayStart(addDays(dhakaDay(), 1)).getTime() + 10 * HOUR);
const createBody = (f: Fixtures) => ({ ...quoteBody(f, tomorrowTen()), quoteHash: "0".repeat(64), policyAccepted: false, policyVersion: 0 });
const offeringBody = (salonId: string) => ({ salonId, audience: "LADIES", category: "FACIAL", name: "Verify facial", durationMin: 60, priceMinor: 100000 });

export const MATRIX: Route[] = [
  // Public reads
  { home: "GET /catalog", url: (f) => `${H}/catalog?audience=LADIES&lat=${f.lat}&lng=${f.lng}`, grid: PUBLIC },
  { home: "GET /experts", url: (f) => `${H}/experts?audience=LADIES&lat=${f.lat}&lng=${f.lng}`, grid: PUBLIC },
  { home: "GET /experts/:id", url: (f) => `${H}/experts/${f.expert}`, grid: PUBLIC },
  { home: "GET /experts/:id/reviews", url: (f) => `${H}/experts/${f.expert}/reviews`, grid: PUBLIC },
  { home: "GET /availability", url: (f) => `${H}/availability?expertId=${f.expert}&offeringIds=${f.offering}&date=${addDays(dhakaDay(), 1)}`, grid: PUBLIC },
  { home: "GET /availability/days", url: (f) => `${H}/availability/days?expertId=${f.expert}&offeringIds=${f.offering}`, grid: PUBLIC },

  // Only a customer books
  { home: "POST /bookings/quote", url: () => `${H}/bookings/quote`, body: (f) => quoteBody(f, tomorrowTen()), grid: CUSTOMER_ONLY },
  { home: "POST /bookings", url: () => `${H}/bookings`, body: createBody, grid: CUSTOMER_ONLY },

  // A customer's own booking, else 404
  { home: "GET /bookings/me", url: () => `${H}/bookings/me`, grid: SIGNED_IN },
  { home: "GET /bookings/:id", url: (_f, id) => `${H}/bookings/${id}`, grid: OWN_BOOKING, fresh: "booking" },
  { home: "POST /bookings/:id/pay", url: (_f, id) => `${H}/bookings/${id}/pay`, body: () => ({ method: "WALLET" }), grid: OWN_BOOKING, fresh: "booking" },
  { home: "POST /bookings/:id/pay-balance", url: (_f, id) => `${H}/bookings/${id}/pay-balance`, grid: OWN_BOOKING, fresh: "booking" },
  { home: "GET /bookings/:id/cancel-quote", url: (_f, id) => `${H}/bookings/${id}/cancel-quote`, grid: OWN_BOOKING, fresh: "booking" },
  { home: "POST /bookings/:id/cancel", url: (_f, id) => `${H}/bookings/${id}/cancel`, body: () => reason, grid: OWN_BOOKING, fresh: "booking" },
  {
    home: "POST /bookings/:id/reschedule",
    url: (_f, id) => `${H}/bookings/${id}/reschedule`,
    body: () => ({ date: addDays(dhakaDay(), 1), startAt: tomorrowTen().toISOString() }),
    grid: OWN_BOOKING,
    fresh: "booking",
  },
  { home: "POST /bookings/:id/appeal", url: (_f, id) => `${H}/bookings/${id}/appeal`, body: () => reason, grid: OWN_BOOKING, fresh: "booking" },
  {
    home: "POST /bookings/:id/report",
    url: (_f, id) => `${H}/bookings/${id}/report`,
    body: () => ({ kind: "OTHER", details: "verify:home access matrix" }),
    grid: OWN_BOOKING,
    fresh: "booking",
  },
  { home: "POST /bookings/:id/help", url: (_f, id) => `${H}/bookings/${id}/help`, grid: OWN_BOOKING, fresh: "booking" },
  { home: "POST /bookings/:id/review", url: (_f, id) => `${H}/bookings/${id}/review`, body: () => ({ rating: 5 }), grid: OWN_BOOKING, fresh: "booking" },

  // Saved addresses
  { home: "GET /addresses", url: () => `${H}/addresses`, grid: ADDRESS_LIST },
  {
    home: "POST /addresses",
    url: () => `${H}/addresses`,
    body: (f) => ({ label: "Home", addressLine: "House 1, Road 1", latitude: f.lat, longitude: f.lng }),
    grid: ADDRESS_LIST,
  },
  { home: "PATCH /addresses/:id", url: (f) => `${H}/addresses/${f.address}`, body: () => ({ label: "Work" }), grid: ADDRESS_WRITE },
  { home: "DELETE /addresses/:id", url: (f) => `${H}/addresses/${f.address}`, grid: ADDRESS_WRITE },

  // An expert sees only their own jobs
  { home: "GET /jobs", url: () => `${H}/jobs`, grid: JOB_LIST },
  { home: "GET /jobs/:id", url: (_f, id) => `${H}/jobs/${id}`, grid: OWN_JOB, fresh: "booking" },
  { home: "POST /jobs/:id/en-route", url: (_f, id) => `${H}/jobs/${id}/en-route`, grid: OWN_JOB, fresh: "booking" },
  { home: "POST /jobs/:id/arrived", url: (_f, id) => `${H}/jobs/${id}/arrived`, grid: OWN_JOB, fresh: "booking" },
  { home: "POST /jobs/:id/start", url: (_f, id) => `${H}/jobs/${id}/start`, body: () => ({ code: "0000" }), grid: OWN_JOB, fresh: "booking" },
  {
    home: "POST /jobs/:id/complete",
    url: (_f, id) => `${H}/jobs/${id}/complete`,
    body: () => ({ balanceMethod: "CASH", collectedMinor: 0 }),
    grid: OWN_JOB,
    fresh: "booking",
  },
  { home: "POST /jobs/:id/no-show", url: (_f, id) => `${H}/jobs/${id}/no-show`, grid: OWN_JOB, fresh: "booking" },
  { home: "POST /jobs/:id/abort", url: (_f, id) => `${H}/jobs/${id}/abort`, body: () => ({ kind: "SAFETY", ...reason }), grid: OWN_JOB, fresh: "booking" },
  {
    home: "POST /jobs/:id/report",
    url: (_f, id) => `${H}/jobs/${id}/report`,
    body: () => ({ kind: "OTHER", details: "verify:home access matrix" }),
    grid: OWN_JOB,
    fresh: "booking",
  },

  // Owner: settings, menu, experts
  { home: "GET /owner/profile", url: (f) => `${O}/profile?${salonQ(f.salon)}`, grid: BRANCH("ok") },
  { home: "PUT /owner/profile", url: () => `${O}/profile`, body: (f) => ({ salonId: f.salon, travelBufferMin: 30 }), grid: BRANCH("through") },
  { home: "POST /owner/profile/turn-on", url: () => `${O}/profile/turn-on`, body: (f) => ({ salonId: f.spareBranch, ladies: true, gents: false }), grid: OWNER_SWITCH },
  { home: "POST /owner/profile/turn-off", url: () => `${O}/profile/turn-off`, body: (f) => ({ salonId: f.spareBranch, upcoming: "KEEP" }), grid: OWNER_SWITCH },
  { home: "POST /owner/profile/pause", url: () => `${O}/profile/pause`, body: (f) => ({ salonId: f.spareBranch }), grid: OWNER_SWITCH },
  { home: "POST /owner/profile/resume", url: () => `${O}/profile/resume`, body: (f) => ({ salonId: f.spareBranch }), grid: OWNER_SWITCH },
  { home: "GET /owner/offerings", url: (f) => `${O}/offerings?${salonQ(f.salon)}`, grid: BRANCH("ok") },
  { home: "POST /owner/offerings", url: () => `${O}/offerings`, body: (f) => offeringBody(f.salon), grid: BRANCH("through") },
  { home: "PATCH /owner/offerings/:id", url: (_f, id) => `${O}/offerings/${id}`, body: () => ({ priceMinor: 110000 }), grid: BRANCH("through"), fresh: "offering" },
  { home: "POST /owner/offerings/:id/toggle", url: (_f, id) => `${O}/offerings/${id}/toggle`, grid: BRANCH("through"), fresh: "offering" },
  { home: "DELETE /owner/offerings/:id", url: (_f, id) => `${O}/offerings/${id}`, grid: BRANCH("through"), fresh: "offering" },
  { home: "GET /owner/experts", url: (f) => `${O}/experts?${salonQ(f.salon)}`, grid: BRANCH("ok") },
  { home: "GET /owner/experts/candidates", url: (f) => `${O}/experts/candidates?${salonQ(f.salon)}`, grid: BRANCH("ok") },
  {
    home: "POST /owner/experts",
    url: () => `${O}/experts`,
    body: (f) => ({ salonId: f.salon, staffId: f.candidateStaff, gender: "FEMALE" }),
    grid: BRANCH("through"),
  },
  { home: "PATCH /owner/experts/:id", url: (_f, id) => `${O}/experts/${id}`, body: () => ({ headline: "Verify" }), grid: BRANCH("through"), fresh: "expert" },
  { home: "PUT /owner/experts/:id/offerings", url: (_f, id) => `${O}/experts/${id}/offerings`, body: () => ({ offeringIds: [] }), grid: BRANCH("through"), fresh: "expert" },
  {
    home: "POST /owner/experts/:id/doc-upload-signature",
    url: (f) => `${O}/experts/${f.expert}/doc-upload-signature`, // VERIFIED: refused before it reaches Cloudinary
    body: () => ({ kind: "SELFIE" }),
    grid: BRANCH("through"),
  },
  {
    home: "POST /owner/experts/:id/docs",
    url: (f) => `${O}/experts/${f.expert}/docs`,
    body: () => ({ kind: "SELFIE", publicId: "verify/selfie", bytes: 1000 }),
    grid: BRANCH("through"),
  },
  { home: "POST /owner/experts/:id/submit", url: (f) => `${O}/experts/${f.expert}/submit`, grid: BRANCH("through") },
  { home: "DELETE /owner/experts/:id", url: (_f, id) => `${O}/experts/${id}`, body: () => reason, grid: BRANCH("through"), fresh: "expert" },

  // Owner: board
  {
    // A list, so a branch outside the caller's scope is an empty page (scopeSalonIds), not a 404.
    home: "GET /owner/bookings",
    url: (f) => `${O}/bookings?${salonQ(f.salon)}`,
    grid: { ...BRANCH("ok"), otherOwner: "empty", expert: "empty", otherExpert: "empty", xExpert: "empty", staff: "empty" },
  },
  { home: "GET /owner/bookings/:id/eligible-experts", url: (_f, id) => `${O}/bookings/${id}/eligible-experts`, grid: BRANCH("ok"), fresh: "booking" },
  {
    home: "POST /owner/bookings/:id/reassign",
    url: (_f, id) => `${O}/bookings/${id}/reassign`,
    body: (f) => ({ expertId: f.otherExpert, ...reason }),
    grid: BRANCH("through"),
    fresh: "booking",
  },
  { home: "POST /owner/bookings/:id/override-start", url: (_f, id) => `${O}/bookings/${id}/override-start`, body: () => reason, grid: BRANCH("through"), fresh: "booking" },
  { home: "POST /owner/bookings/:id/cancel", url: (_f, id) => `${O}/bookings/${id}/cancel`, body: () => reason, grid: BRANCH("through"), fresh: "booking" },
  { home: "POST /owner/bookings/:id/expert-no-show", url: (_f, id) => `${O}/bookings/${id}/expert-no-show`, body: () => reason, grid: BRANCH("through"), fresh: "booking" },

  // Back office. SUPPORT and ANALYST hold view only, so every write refuses them.
  { admin: "GET /profiles", url: () => `${A}/profiles`, grid: adminRead(VIEW) },
  { admin: "POST /profiles/:id/approve", url: (f) => `${A}/profiles/${f.profile}/approve`, grid: adminWrite(MANAGE) },
  { admin: "POST /profiles/:id/reject", url: (f) => `${A}/profiles/${f.profile}/reject`, body: () => reason, grid: adminWrite(MANAGE) },
  { admin: "POST /profiles/:id/suspend", url: (f) => `${A}/profiles/${f.profile}/suspend`, body: () => reason, grid: adminWrite(MANAGE) },
  { admin: "POST /profiles/:id/unsuspend", url: (f) => `${A}/profiles/${f.profile}/unsuspend`, grid: adminWrite(MANAGE) },
  { admin: "GET /experts", url: () => `${A}/experts`, grid: adminRead(VIEW) },
  { admin: "GET /experts/:id/documents", url: (f) => `${A}/experts/${f.expert}/documents`, grid: adminWrite(MANAGE) },
  { admin: "POST /experts/:id/verify", url: (f) => `${A}/experts/${f.expert}/verify`, grid: adminWrite(MANAGE) },
  { admin: "POST /experts/:id/reject", url: (f) => `${A}/experts/${f.expert}/reject`, body: () => reason, grid: adminWrite(MANAGE) },
  { admin: "POST /experts/:id/suspend", url: (f) => `${A}/experts/${f.expert}/suspend`, body: () => reason, grid: adminWrite(MANAGE) },
  { admin: "POST /experts/:id/gender", url: (f) => `${A}/experts/${f.expert}/gender`, body: () => ({ gender: "FEMALE", ...reason }), grid: adminWrite(MANAGE) },
  { admin: "GET /bookings", url: () => `${A}/bookings`, grid: adminRead(VIEW) },
  { admin: "GET /bookings/:id", url: (f) => `${A}/bookings/${f.booking}`, grid: adminRead(VIEW) },
  { admin: "POST /bookings/:id/cancel", url: (f) => `${A}/bookings/${f.booking}/cancel`, body: () => ({ ...reason, salonAtFault: false }), grid: adminWrite(MANAGE) },
  { admin: "POST /bookings/:id/expert-no-show", url: (f) => `${A}/bookings/${f.booking}/expert-no-show`, body: () => reason, grid: adminWrite(MANAGE) },
  {
    // No step-up by design; a booking with no pending appeal gets the service's own answer.
    admin: "PATCH /bookings/:id/appeal",
    url: (f) => `${A}/bookings/${f.booking}/appeal`,
    body: () => ({ approve: false }),
    grid: grid(403, { guest: 401, ...only(heldBy("appeals.resolve"), "through") }),
  },
  { admin: "GET /policy", url: () => `${A}/policy`, grid: adminRead(VIEW) },
  { admin: "GET /policy/:key/history", url: () => `${A}/policy/homeService.customerCancelPolicy/history`, grid: adminRead(VIEW) },
  { admin: "GET /reports", url: () => `${A}/reports`, grid: adminRead(MANAGE) },
  {
    admin: "POST /reports/:id/status",
    url: (f) => `${A}/reports/${f.report}/status`,
    body: () => ({ status: "ACTIONED", note: "verify:home" }),
    grid: adminWrite(MANAGE),
  },

  // Only homeservice.policy saves homeService.* keys
  {
    other: "PATCH /admin/settings/homeService.customerCancelPolicy",
    url: () => "/api/v1/admin/settings/homeService.customerCancelPolicy",
    body: () => ({ value: "FREE", reason: "verify:home access matrix" }),
    grid: adminWrite(POLICY),
  },
  {
    other: "PATCH /admin/settings/homeService.lateCancelPercent",
    url: () => "/api/v1/admin/settings/homeService.lateCancelPercent",
    body: () => ({ value: 0, reason: "verify:home access matrix" }),
    grid: adminWrite(POLICY),
  },

  // Phase 16 reports
  { other: "GET /owner/reports/home", url: (f) => `/api/v1/owner/reports/home?${salonQ(f.salon)}&compare=1`, grid: BRANCH("ok") },
  { other: "GET /owner/reports/home.csv", url: (f) => `/api/v1/owner/reports/home.csv?${salonQ(f.salon)}`, grid: BRANCH("ok") },
  { other: "GET /admin/analytics/home", url: () => "/api/v1/admin/analytics/home?includeTest=1", grid: adminRead(heldBy("analytics.view")) },
  { other: "GET /admin/analytics/home/export.csv", url: () => "/api/v1/admin/analytics/home/export.csv", grid: adminRead(heldBy("analytics.export")) },
];

// ---------------------------------------------------------------------------
// No database
// ---------------------------------------------------------------------------

type RouteLayer = { route?: { path: string; methods: Record<string, boolean> } };

const routesOf = (router: unknown) =>
  (router as { stack: RouteLayer[] }).stack.flatMap((layer) =>
    layer.route ? Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${layer.route!.path}`) : [],
  );

/** A route added without a row here fails, so the matrix can't quietly fall behind. */
export const checkCoverage = (check: Check) => {
  const home = new Set(MATRIX.flatMap((r) => (r.home ? [r.home] : [])));
  const admin = new Set(MATRIX.flatMap((r) => (r.admin ? [r.admin] : [])));
  const missing = [
    ...routesOf(HomeServiceRoutes).filter((r) => !home.has(r)).map((r) => `home ${r}`),
    ...routesOf(HomeServiceAdminRoutes).filter((r) => !admin.has(r)).map((r) => `admin ${r}`),
  ];
  const stale = [
    ...[...home].filter((r) => !routesOf(HomeServiceRoutes).includes(r)),
    ...[...admin].filter((r) => !routesOf(HomeServiceAdminRoutes).includes(r)),
  ];
  check(
    `matrix covers every route (${home.size + admin.size} routes × ${ROLES.length} roles)`,
    missing.length === 0 && stale.length === 0,
    [...missing, ...stale.map((r) => `stale ${r}`)].join(", "),
  );
};

/** Window cases on the pure engine: a fixed clock, a day open 09:00–20:00 Dhaka. */
export const checkWindow = (check: Check) => {
  const at = (day: string, h: number, m = 0) => new Date(dayStart(day).getTime() + h * HOUR + m * MIN);
  const slots = (date: string, now: Date, days = 7) => {
    const input: SlotInput = {
      date,
      now,
      durationMin: 60,
      stepMin: 30,
      bufferMin: 30,
      minLeadMin: 120,
      bookingWindowDays: days,
      working: [{ from: at(date, 9), to: at(date, 20) }],
      homeHours: { from: at(date, 9), to: at(date, 20) },
      lastStartAt: null,
      busy: [],
      closed: [],
      jobsThatDay: 0,
      maxJobsPerDay: 4,
    };
    return computeSlots(input);
  };
  const today = "2026-11-10";
  const now = at(today, 12, 10);

  check("window · yesterday has no slots", slots(addDays(today, -1), now).length === 0);
  const sameDay = slots(today, now);
  check("window · past times today are not offered", sameDay.every((s) => s > now), `${sameDay.length} slots`);
  check("window · now + 1 h is not offered (lead 120 min)", !sameDay.some((s) => s.getTime() <= now.getTime() + HOUR));
  check(
    "window · first slot today is now + lead, on the grid",
    sameDay[0]?.getTime() === at(today, 14, 30).getTime(),
    sameDay[0]?.toISOString() ?? "none",
  );
  check("window · last day (today + 6) has slots", slots(addDays(today, 6), now).length > 0);
  check("window · today + 7 has none", slots(addDays(today, 7), now).length === 0);
  check("window · a 1-day window is today only", slots(addDays(today, 1), now, 1).length === 0 && slots(today, now, 1).length > 0);

  const beforeMidnight = at(today, 23, 59);
  const afterMidnight = at(addDays(today, 1), 0, 1);
  check("window · 23:59 Dhaka: today + 7 still out", slots(addDays(today, 7), beforeMidnight).length === 0);
  check("window · 00:01 Dhaka: that day is now the last one", slots(addDays(today, 7), afterMidnight).length > 0);
  check("window · 00:01 Dhaka: the old today is yesterday", slots(today, afterMidnight).length === 0);
  check("window · 23:59 Dhaka is 17:59 UTC, one day still", dhakaDay(beforeMidnight) === today && dhakaDay(afterMidnight) === addDays(today, 1));
};

// ---------------------------------------------------------------------------
// Test database: fixtures
// ---------------------------------------------------------------------------

type Hit = { status: number; code?: string; data?: any };

const judge = (want: Want, r: Hit) => {
  if (want === "ok") return r.status >= 200 && r.status < 300;
  if (want === "empty") return r.status === 200 && Array.isArray(r.data) && r.data.length === 0;
  if (want === "through") return r.status < 500 && ![401, 403, 404].includes(r.status);
  if (typeof want === "number") return r.status === want;
  const [status, code] = want.split(":");
  return r.status === Number(status) && r.code === code;
};

const seed = async (tag: string) => {
  const email = (key: string) => `verify-home-${key}-${tag}@seed.example.com`;
  const person = (key: string, role: UserRole, extra: Partial<Prisma.UserCreateInput> = {}) =>
    prisma.user.create({ data: { email: email(key), name: `Verify ${key}`, role, emailVerified: true, isTest: true, ...extra } });

  const lat = 23.81;
  const lng = 90.41;
  const salonOf = (ownerId: string, name: string) =>
    prisma.salon.create({
      data: {
        name: `Verify ${name} ${tag}`,
        address: "Mirpur test road",
        area: "Mirpur",
        city: "Dhaka",
        phone: "01700000000",
        images: [],
        ownerId,
        status: SalonStatus.ACTIVE,
        latitude: lat,
        longitude: lng,
      },
    });

  const ownerUser = await person("owner", UserRole.SALON_OWNER);
  const otherOwnerUser = await person("other-owner", UserRole.SALON_OWNER);
  const owner = await prisma.salonOwner.create({ data: { userId: ownerUser.id, businessName: `Verify ${tag}` } });
  const otherOwner = await prisma.salonOwner.create({ data: { userId: otherOwnerUser.id, businessName: `Verify X ${tag}` } });
  const salon = await salonOf(owner.id, "Main");
  const spare = await salonOf(owner.id, "Spare");
  const other = await salonOf(otherOwner.id, "Other");

  const liveProfile = (salonId: string) =>
    prisma.homeServiceProfile.create({
      data: { salonId, isOn: true, ladiesEnabled: true, gentsEnabled: true, status: HomeServiceStatus.ACTIVE, everApproved: true },
    });
  const profile = await liveProfile(salon.id);
  await liveProfile(other.id);

  const offeringOf = (salonId: string, audience: HomeAudience) =>
    prisma.homeServiceOffering.create({
      data: { salonId, audience, category: HomeCategory.FACIAL, name: `Facial ${audience}`, durationMin: 60, priceMinor: 130000, images: [] },
    });
  const offering = await offeringOf(salon.id, HomeAudience.LADIES);
  const gentsOffering = await offeringOf(salon.id, HomeAudience.GENTS);
  const otherOffering = await offeringOf(other.id, HomeAudience.LADIES);

  const expertOf = async (key: string, salonId: string, gender: Gender, offeringId: string) => {
    const user = await person(key, UserRole.STAFF, { gender });
    const staff = await prisma.staff.create({ data: { userId: user.id, salonId } });
    const expert = await prisma.homeExpert.create({
      data: {
        staffId: staff.id,
        salonId,
        gender,
        audience: gender === Gender.FEMALE ? HomeAudience.LADIES : HomeAudience.GENTS,
        verification: ExpertVerification.VERIFIED,
        languages: [],
        maxJobsPerDay: 8,
        offerings: { create: { offeringId } },
      },
    });
    return { user, staff, expert };
  };
  const e1 = await expertOf("expert", salon.id, Gender.FEMALE, offering.id);
  const e2 = await expertOf("other-expert", salon.id, Gender.FEMALE, offering.id);
  const male = await expertOf("male-expert", salon.id, Gender.MALE, gentsOffering.id);
  const xe = await expertOf("x-expert", other.id, Gender.FEMALE, otherOffering.id);

  const staffUser = await person("staff", UserRole.STAFF, { gender: Gender.FEMALE });
  const candidate = await prisma.staff.create({ data: { userId: staffUser.id, salonId: salon.id } });
  const manager = await person("manager", UserRole.BRANCH_MANAGER);
  await prisma.salonMember.create({ data: { salonId: salon.id, userId: manager.id, role: "MANAGER" } });

  const customerOf = async (key: string) => {
    const user = await person(key, UserRole.CUSTOMER, { phone: "01711111111" });
    await WalletService.mutate({
      userId: user.id,
      type: WalletTxType.ADJUSTMENT,
      amount: 5_000_000,
      description: "verify:home funding",
      idempotencyKey: `verify-home-fund:${user.id}`,
    });
    return user;
  };
  const customer = await customerOf("customer");
  const otherCustomer = await customerOf("other-customer");

  const admins = {} as Record<(typeof ADMIN_ROLES)[number], { id: string; email: string; role: UserRole }>;
  for (const adminRole of ADMIN_ROLES) {
    const user = await person(`admin-${adminRole.toLowerCase()}`, UserRole.ADMIN);
    await prisma.admin.create({ data: { userId: user.id, adminRole: AdminRole[adminRole] } });
    await prisma.userMfa.create({ data: { userId: user.id, secretEnc: "verify", enabledAt: new Date(), recoveryCodeHashes: [] } });
    admins[adminRole] = user;
  }
  const agent = await person("agent", UserRole.AGENT);
  await prisma.agent.create({ data: { userId: agent.id, division: "Dhaka", district: "Dhaka", area: "Mirpur" } });
  await prisma.userMfa.create({ data: { userId: agent.id, secretEnc: "verify", enabledAt: new Date(), recoveryCodeHashes: [] } });

  const users: Record<Exclude<Role, "guest">, { id: string; email: string; role: UserRole }> = {
    customer,
    otherCustomer,
    owner: ownerUser,
    otherOwner: otherOwnerUser,
    manager,
    expert: e1.user,
    otherExpert: e2.user,
    xExpert: xe.user,
    staff: staffUser,
    ...admins,
    AGENT: agent,
  };

  const snapshot = policySnapshotOf(await currentPolicy()) as unknown as Prisma.InputJsonValue;
  let slot = 0;
  /** A paid visit far enough ahead that no two overlap, advance held. */
  const visit = async (expertId = e1.expert.id) => {
    const n = (slot += 1);
    const startAt = new Date(Date.now() + 72 * HOUR + n * 3 * HOUR);
    const endAt = new Date(startAt.getTime() + HOUR);
    const b = await prisma.homeBooking.create({
      data: {
        code: `HS-V${tag.slice(0, 5).toUpperCase()}${n}`,
        customerId: customer.id,
        salonId: salon.id,
        expertId,
        audience: HomeAudience.LADIES,
        expertAudience: HomeAudience.LADIES,
        status: HomeBookingStatus.CONFIRMED,
        startAt,
        endAt,
        blockFrom: startAt,
        blockTo: endAt,
        serviceDate: new Date(`${dhakaDay(startAt)}T00:00:00Z`),
        addressLine: "House 1, Road 1",
        latitude: lat,
        longitude: lng,
        distanceKm: 1,
        recipientName: "Verify",
        contactPhone: "01711111111",
        subtotalMinor: 130000,
        travelFeeMinor: 0,
        totalMinor: 130000,
        advancePercent: 50,
        advanceMinor: 65000,
        balanceMinor: 65000,
        commissionBps: 0,
        policySnapshot: snapshot,
        disclaimerText: "verify",
        confirmedAt: new Date(),
        items: { create: { offeringId: offering.id, nameSnapshot: "Facial", priceMinor: 130000, durationMin: 60 } },
      },
      select: { id: true },
    });
    await prisma.$transaction(async (tx) => {
      await WalletService.holdHomeAdvance(customer.id, 65000, b.id, tx);
      await tx.homeBooking.update({ where: { id: b.id }, data: { advanceStatus: AdvanceStatus.HELD } });
    });
    return b.id;
  };

  const booking = await visit();
  const report = await prisma.homeSafetyReport.create({
    data: { bookingId: booking, reporterId: customer.id, reporterRole: "CUSTOMER", kind: "OTHER", details: "verify:home" },
  });
  const address = await prisma.customerAddress.create({
    data: { userId: customer.id, label: "Home", addressLine: "House 1, Road 1", latitude: lat, longitude: lng },
  });

  const newOffering = async () => (await offeringOf(salon.id, HomeAudience.LADIES)).id;
  const newExpert = async () => {
    const n = (slot += 1);
    return (await expertOf(`spare-expert-${n}`, salon.id, Gender.FEMALE, offering.id)).expert.id;
  };

  const fixtures: Fixtures = {
    salon: salon.id,
    spareBranch: spare.id,
    otherSalon: other.id,
    booking,
    offering: offering.id,
    gentsOffering: gentsOffering.id,
    otherOffering: otherOffering.id,
    expert: e1.expert.id,
    maleExpert: male.expert.id,
    otherExpert: e2.expert.id,
    candidateStaff: candidate.id,
    profile: profile.id,
    report: report.id,
    address: address.id,
    lat,
    lng,
  };
  return { fixtures, users, visit, newOffering, newExpert, person, customerOf, staffId: e1.staff.id, salonIds: [salon.id, spare.id, other.id], ownerIds: [owner.id, otherOwner.id] };
};

const removeFixtures = async (tag: string, salonIds: string[], ownerIds: string[]) => {
  const pattern = `verify-home-%-${tag}@seed.example.com`;
  await prisma.$transaction(
    async (tx) => {
      const ids = Prisma.join(salonIds);
      await tx.$executeRaw`DELETE FROM ledger_entries WHERE "salonId" IN (${ids})`;
      await tx.$executeRaw`DELETE FROM reviews WHERE "salonId" IN (${ids})`;
      await tx.$executeRaw`DELETE FROM home_bookings WHERE "salonId" IN (${ids})`;
      await tx.$executeRaw`DELETE FROM appointments WHERE "salonId" IN (${ids})`;
      await tx.$executeRaw`DELETE FROM salons WHERE id IN (${ids})`;
      await tx.$executeRaw`DELETE FROM salon_owners WHERE id IN (${Prisma.join(ownerIds)})`;
      await tx.$executeRaw`DELETE FROM support_tickets WHERE "userId" IN (SELECT id FROM users WHERE email LIKE ${pattern})`;
      await tx.$executeRaw`DELETE FROM wallet_transactions WHERE "walletId" IN (SELECT w.id FROM wallets w JOIN users u ON u.id = w."userId" WHERE u.email LIKE ${pattern})`;
      await tx.$executeRaw`DELETE FROM wallets WHERE "userId" IN (SELECT id FROM users WHERE email LIKE ${pattern})`;
      await tx.$executeRaw`DELETE FROM users WHERE email LIKE ${pattern}`;
    },
    { timeout: 60_000 },
  );
};

// ---------------------------------------------------------------------------
// Test database: the checks
// ---------------------------------------------------------------------------

export const runLive = async (check: Check) => {
  // The limiters key on the client address; each request here is its own client.
  config.internalApiKey = config.internalApiKey || "verify-home";
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const tag = randomUUID().slice(0, 8);
  const seeded = await seed(tag);
  const { fixtures: f, users } = seeded;

  const tokens = new Map<string, string>();
  const tokenOf = (u: { id: string; email: string; role: UserRole }) => {
    let t = tokens.get(u.id);
    if (!t) {
      t = jwtHelpers.createToken({ userId: u.id, email: u.email, role: u.role, sv: 0 }, config.jwt.jwt_secret as string, "1h");
      tokens.set(u.id, t);
    }
    return t;
  };

  let ip = 0;
  const hit = async (
    who: { id: string; email: string; role: UserRole } | null,
    method: string,
    url: string,
    body?: unknown,
  ): Promise<Hit> => {
    ip += 1;
    const res = await fetch(base + url, {
      method,
      headers: {
        "content-type": "application/json",
        "x-internal-key": String(config.internalApiKey),
        "x-client-ip": `10.${(ip >> 16) & 255}.${(ip >> 8) & 255}.${ip & 255}`,
        "idempotency-key": randomUUID(),
        ...(who ? { authorization: `Bearer ${tokenOf(who)}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      return { status: res.status, code: json.errorCode, data: json.data };
    } catch {
      return { status: res.status };
    }
  };
  const asUser = (role: Role) => (role === "guest" ? null : users[role]);

  try {
    // ---------------------------------------------------------------- the matrix
    const failures: string[] = [];
    let cells = 0;
    const record = (name: string, role: Role, want: Want, r: Hit, url: string) => {
      cells += 1;
      if (!judge(want, r)) failures.push(`${name} · ${role}: wanted ${want}, got ${r.status}${r.code ? ` ${r.code}` : ""} (${url.split("?")[0]})`);
    };

    for (const route of MATRIX) {
      const name = route.home ?? route.admin ?? route.other ?? "";
      const method = name.split(" ")[0];
      const passes = (w: Want) => w === "ok" || w === "through"; // "empty" is a refusal: it changes nothing
      const passing = ROLES.filter((role) => passes(route.grid[role]));
      const denied = ROLES.filter((role) => !passes(route.grid[role]));

      // Refusals first and in parallel: none of them may change anything.
      const defaultId =
        route.fresh === "offering" ? f.offering : route.fresh === "expert" ? f.expert : f.booking;
      await Promise.all(
        denied.map(async (role) => {
          const url = route.url(f, defaultId);
          record(name, role, route.grid[role], await hit(asUser(role), method, url, route.body?.(f, defaultId)), url);
        }),
      );
      for (const role of passing) {
        const id = route.fresh === "offering" ? await seeded.newOffering() : route.fresh === "expert" ? await seeded.newExpert() : route.fresh === "booking" ? await seeded.visit() : defaultId;
        const url = route.url(f, id);
        record(name, role, route.grid[role], await hit(asUser(role), method, url, route.body?.(f, id)), url);
      }
    }
    check(`access matrix · ${cells} cells`, failures.length === 0, failures.length ? `${failures.length} wrong` : "");
    for (const line of failures) check(`access · ${line}`, false);

    // ---------------------------------------------------------------- named rules
    const quoteAs = (who: Role, body: unknown) => hit(asUser(who), "POST", `${H}/bookings/quote`, body);

    // The matrix left `customer` at the active-visit limit; `otherCustomer` has no visits.
    const custOnly = await quoteAs("owner", quoteBody(f, tomorrowTen()));
    check("rule · a salon owner can't book", custOnly.status === 403 && custOnly.code === "HOME_SERVICE_CUSTOMER_ONLY", `${custOnly.status} ${custOnly.code}`);

    const crossBooking = await hit(users.otherOwner, "POST", `${O}/bookings/${f.booking}/cancel`, reason);
    check("rule · another business's booking answers 404", crossBooking.status === 404, `${crossBooking.status}`);

    const crossSalon = await hit(users.manager, "GET", `${O}/profile?${salonQ(f.otherSalon)}`);
    check("rule · a manager of one business, another's branch: 404", crossSalon.status === 404, `${crossSalon.status}`);

    const managerSwitch = await hit(users.manager, "POST", `${O}/profile/turn-off`, { salonId: f.salon, upcoming: "KEEP" });
    check("rule · a manager can't turn the branch off", managerSwitch.status === 403, `${managerSwitch.status}`);

    const jobsOfOther = await hit(users.otherExpert, "GET", `${H}/jobs/${f.booking}`);
    check("rule · an expert can't open another expert's job", jobsOfOther.status === 404, `${jobsOfOther.status}`);

    // ---------------------------------------------------------------- gender
    const femaleGents = await hit(users.owner, "PUT", `${O}/experts/${f.expert}/offerings`, { offeringIds: [f.gentsOffering] });
    check("gender · FEMALE expert + GENTS offering refused", femaleGents.status === 400 && femaleGents.code === "EXPERT_GENDER_MISMATCH", `${femaleGents.status} ${femaleGents.code}`);

    const slotsRes = await hit(users.customer, "GET", `${H}/availability?expertId=${f.expert}&offeringIds=${f.offering}&date=${addDays(dhakaDay(), 1)}`);
    const slotsOf = (r: Hit): Array<{ startAt: string }> => r.data?.slots ?? [];
    const first = slotsOf(slotsRes)[0];
    check("window · tomorrow has slots through the API", Boolean(first), `${slotsOf(slotsRes).length} slots`);
    const startAt = new Date(first?.startAt ?? tomorrowTen());

    const maleLadies = await quoteAs("otherCustomer", quoteBody(f, startAt, { expertId: f.maleExpert }));
    check(
      "gender · MALE expert + LADIES cart refused",
      maleLadies.status >= 400 && maleLadies.status < 500 && ["EXPERT_UNAVAILABLE", "EXPERT_GENDER_MISMATCH", "EXPERT_CANNOT_DO_SERVICE"].includes(maleLadies.code ?? ""),
      `${maleLadies.status} ${maleLadies.code}`,
    );

    const toReassign = await seeded.visit();
    const reassignMale = await hit(users.owner, "POST", `${O}/bookings/${toReassign}/reassign`, { expertId: f.maleExpert, ...reason });
    check("gender · reassign a Ladies visit to a male expert refused", reassignMale.status === 400 && reassignMale.code === "EXPERT_GENDER_MISMATCH", `${reassignMale.status} ${reassignMale.code}`);

    // ---------------------------------------------------------------- window, through the API
    const quoteAt = (when: Date) => quoteAs("otherCustomer", quoteBody(f, when));
    const onGrid = (t: number) => new Date(Math.floor(t / (30 * MIN)) * (30 * MIN));
    const today = dhakaDay();
    const { bookingWindowDays } = await import("../app/modules/HomeService/home.availability").then((m) => m.loadSlotSettings());

    const cases: Array<[string, Date, string[]]> = [
      ["yesterday", new Date(dayStart(addDays(today, -1)).getTime() + 10 * HOUR), ["OUTSIDE_BOOKING_WINDOW"]],
      ["a past time", onGrid(Date.now() - HOUR), ["TOO_SOON", "OUTSIDE_BOOKING_WINDOW"]],
      ["now + 1 h", onGrid(Date.now() + HOUR), ["TOO_SOON"]],
      ["window + 1", new Date(dayStart(addDays(today, bookingWindowDays)).getTime() + 10 * HOUR), ["OUTSIDE_BOOKING_WINDOW"]],
    ];
    for (const [label, when, codes] of cases) {
      const r = await quoteAt(when);
      check(`window · ${label} refused by the API`, codes.includes(r.code ?? ""), `${r.status} ${r.code}`);
    }
    const lastDay = new Date(dayStart(addDays(today, bookingWindowDays - 1)).getTime() + 10 * HOUR);
    const last = await quoteAt(lastDay);
    check("window · the last day is inside it", last.status === 200, `${last.status} ${last.code ?? ""}`);
    const midnight = await quoteAt(dayStart(addDays(today, 1)));
    check(
      "window · Dhaka midnight tomorrow: in the window, no slot at that hour",
      ["SLOT_TAKEN", "NO_EXPERT_FREE"].includes(midnight.code ?? ""),
      `${midnight.status} ${midnight.code}`,
    );

    // ---------------------------------------------------------------- 20 parallel creates
    const racers: Array<Awaited<ReturnType<typeof seeded.customerOf>>> = [];
    for (let i = 0; i < 20; i += 1) racers.push(await seeded.customerOf(`racer-${i}`));
    const bodies = await Promise.all(
      racers.map(async (u) => {
        const q = await hit(u, "POST", `${H}/bookings/quote`, quoteBody(f, startAt));
        return { ...quoteBody(f, startAt), quoteHash: q.data?.quoteHash, policyVersion: q.data?.policyVersion, policyAccepted: true };
      }),
    );
    check("race · all 20 customers got a quote", bodies.every((b) => typeof b.quoteHash === "string"), `${bodies.filter((b) => b.quoteHash).length}/20`);
    const results = await Promise.all(racers.map((u, i) => hit(u, "POST", `${H}/bookings`, bodies[i])));
    const won = results.filter((r) => r.status === 201).length;
    const lost = results.filter((r) => r.status === 409 && r.code === "SLOT_TAKEN").length;
    check("race · 20 parallel creates: one wins", won === 1, `${won} × 201, ${lost} × SLOT_TAKEN, others ${[...new Set(results.filter((r) => r.status !== 201 && r.code !== "SLOT_TAKEN").map((r) => `${r.status} ${r.code}`))].join(", ")}`);
    check("race · the other 19 answer SLOT_TAKEN", lost === 19, `${lost}`);
    const held = await prisma.homeBooking.count({ where: { expertId: f.expert, startAt, status: { in: [HomeBookingStatus.PENDING_PAYMENT, HomeBookingStatus.CONFIRMED] } } });
    check("race · one row in the database", held === 1, `${held}`);

    // ---------------------------------------------------------------- salon appointment vs home booking
    const service = await prisma.service.create({
      data: { name: "Verify cut", priceMinor: 50000, duration: 60, salonId: f.salon, images: [], category: "HAIRCUT" as never },
    });
    const counter = await prisma.counter.create({ data: { salonId: f.salon, name: "Verify counter" } });
    await prisma.staffService.create({ data: { staffId: seeded.staffId, serviceId: service.id } }).catch(() => undefined);

    const raceSlots = slotsOf(slotsRes).slice(4);
    let rounds = 0;
    let oneWins = 0;
    const seen: string[] = [];
    for (let i = 0; i < raceSlots.length && rounds < 3; i += 4) {
      const at = new Date(raceSlots[i].startAt);
      const day = dhakaDay(at);
      const dhaka = new Date(at.getTime() + 6 * HOUR).toISOString();
      const startTime = dhaka.slice(11, 16);
      const endTime = new Date(at.getTime() + 7 * HOUR).toISOString().slice(11, 16);
      const slot = await prisma.slot.create({
        data: { salonId: f.salon, serviceId: service.id, counterId: counter.id, date: new Date(`${day}T00:00:00Z`), startTime, endTime },
      });
      const home = await seeded.customerOf(`home-${i}`);
      const walkUp = await seeded.customerOf(`salon-${i}`);
      const q = await hit(home, "POST", `${H}/bookings/quote`, quoteBody(f, at));
      // Without a quote the home side can't reach the claim, and the round proves nothing.
      if (!q.data?.quoteHash) {
        seen.push(`no quote: ${q.status} ${q.code ?? ""}`);
        rounds += 1;
        continue;
      }
      const [salonRes, homeRes] = await Promise.all([
        hit(walkUp, "POST", "/api/v1/appointments", { salonId: f.salon, serviceId: service.id, staffId: seeded.staffId, counterId: counter.id, slotId: slot.id }),
        hit(home, "POST", `${H}/bookings`, { ...quoteBody(f, at), quoteHash: q.data?.quoteHash, policyVersion: q.data?.policyVersion, policyAccepted: true }),
      ]);
      rounds += 1;
      const wins = [salonRes, homeRes].filter((r) => r.status >= 200 && r.status < 300).length;
      if (wins === 1) oneWins += 1;
      seen.push(`salon ${salonRes.status} ${salonRes.code ?? ""} / home ${homeRes.status} ${homeRes.code ?? ""}`.replace(/\s+/g, " "));
    }
    check("race · salon appointment vs home booking on one stylist: one wins", rounds === 3 && oneWins === rounds, `${oneWins}/${rounds}: ${seen.join(" · ")}`);

    // The parallel rounds can all fall one way, so the other order is forced: home holds the stylist first.
    const held2 = new Date(raceSlots[raceSlots.length - 1].startAt);
    const holder = await seeded.customerOf("home-first");
    const walkIn = await seeded.customerOf("salon-second");
    const holdQuote = await hit(holder, "POST", `${H}/bookings/quote`, quoteBody(f, held2));
    const holdRes = await hit(holder, "POST", `${H}/bookings`, { ...quoteBody(f, held2), quoteHash: holdQuote.data?.quoteHash, policyVersion: holdQuote.data?.policyVersion, policyAccepted: true });
    const heldDay = dhakaDay(held2);
    const heldSlot = await prisma.slot.create({
      data: {
        salonId: f.salon,
        serviceId: service.id,
        counterId: counter.id,
        date: new Date(`${heldDay}T00:00:00Z`),
        startTime: new Date(held2.getTime() + 6 * HOUR).toISOString().slice(11, 16),
        endTime: new Date(held2.getTime() + 7 * HOUR).toISOString().slice(11, 16),
      },
    });
    const lateSalon = await hit(walkIn, "POST", "/api/v1/appointments", { salonId: f.salon, serviceId: service.id, staffId: seeded.staffId, counterId: counter.id, slotId: heldSlot.id });
    check(
      "race · a home booking holds the stylist: the salon appointment is refused",
      holdRes.status === 201 && lateSalon.status === 409,
      `home ${holdRes.status} ${holdRes.code ?? ""}, salon ${lateSalon.status} ${lateSalon.code ?? ""}`,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await removeFixtures(tag, seeded.salonIds, seeded.ownerIds).catch((error) => {
      console.log(`note: fixtures left on the test database (tag ${tag}): ${error instanceof Error ? error.message.split("\n").pop() : error}`);
    });
  }
};
