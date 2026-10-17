import { AppointmentStatus, Prisma, ReviewStatus, UserRole } from "@prisma/client";
import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import catchAsync from "../../shared/catchAsync";
import prisma from "../../shared/prisma";
import sendResponse from "../../shared/sendResponse";
import { CsvColumn, streamCsv } from "../../utils/csv";
import { AccessUser, scopeSalonIds, withAccessCache } from "../../utils/salonAccess";
import { addDays, dateOnly, dayStart, daysBetween, dhakaDay, isDay, utcTs } from "../Analytics/analytics.days";
import { getSalonMoneyRange } from "../Settlement/settlement.earnings";
import { OwnerTeam } from "./owner.team";
import { typeOf } from "./owner.money";

/**
 * Owner Reports (owner Phase 12): `GET /owner/reports/:report` and `.csv`.
 *
 * Scope is `reports.view` (owners: every branch or one; managers: theirs).
 * Days are Asia/Dhaka. Money comes from `getSalonMoneyRange` on the same
 * bases as the monthly statement, so Reports equal the Money hub. Like the
 * Money hub, Home and Team, an owner's own test rows are counted: the
 * `isTest` filter is a platform-analytics rule, and excluding them here would
 * make Reports disagree with the statement.
 *
 * Shapes follow the admin analytics ones the frontend charts already take:
 * KPIs `{ id, label, value, previous?, unit, goodDirection }`, series
 * `{ day, value }`. A figure we do not track is `{ available: false, reason }`,
 * never a zero.
 */

export const REPORTS = ["overview", "bookings", "services", "team", "customers", "utilisation", "discovery", "money"] as const;
export type ReportName = (typeof REPORTS)[number];

const MAX_DAYS = 366;
const CANCELLED = AppointmentStatus.CANCELLED;

type Unit = "count" | "minor" | "percent" | "hours" | "days";
type Kpi = { id: string; label: string; value: number | null; previous?: number | null; unit: Unit; goodDirection: "up" | "down" };
type Range = { from: string; to: string; days: string[] };
type Ctx = { user: AccessUser; salonIds: string[]; salonId: string | null; range: Range; prev: Range | null; isOwner: boolean };
type Unavailable = { available: false; reason: string };

const unavailable = (reason: string): Unavailable => ({ available: false, reason });
const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// Query parsing and scope
// ---------------------------------------------------------------------------

type Query = { salonId?: unknown; from?: unknown; to?: unknown; compare?: unknown };

const rangeOf = (q: Query): { range: Range; prev: Range | null } => {
  const today = dhakaDay();
  const from = q.from === undefined || q.from === "" ? addDays(today, -29) : q.from;
  const to = q.to === undefined || q.to === "" ? today : q.to;
  if (!isDay(from) || !isDay(to) || to < from) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "from and to must be days in YYYY-MM-DD format, from first.");
  }
  const days = daysBetween(from, to);
  if (days.length > MAX_DAYS) throw new ApiError(StatusCodes.BAD_REQUEST, "Pick at most a year.");
  const compare = q.compare === "1" || q.compare === "true" || q.compare === "prev";
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days.length - 1));
  return {
    range: { from, to, days },
    prev: compare ? { from: prevFrom, to: prevTo, days: daysBetween(prevFrom, prevTo) } : null,
  };
};

const contextOf = async (user: AccessUser, q: Query): Promise<Ctx> => {
  const requested = typeof q.salonId === "string" && q.salonId && q.salonId !== "all" ? q.salonId : undefined;
  const scope = await scopeSalonIds(user, "reports.view", requested);
  // An admin has every salon; reports are per business, so one must be named.
  const salonIds = scope === null ? (requested ? [requested] : []) : scope;
  if (scope === null && !requested) throw new ApiError(StatusCodes.BAD_REQUEST, "Pick a branch.");
  if (requested && !salonIds.length) throw new ApiError(StatusCodes.NOT_FOUND, "Not found");
  return { user, salonIds, salonId: requested ?? null, ...rangeOf(q), isOwner: user.role === UserRole.SALON_OWNER };
};

// SQL fragments. Appointment and slot days are stored as UTC midnight of the Dhaka date.
const inSalons = (col: string, ids: string[]) =>
  ids.length ? Prisma.sql`${Prisma.raw(col)} IN (${Prisma.join(ids)})` : Prisma.sql`false`;
const onDays = (col: string, r: Range) =>
  Prisma.sql`${Prisma.raw(col)} >= ${utcTs(dateOnly(r.from))} AND ${Prisma.raw(col)} < ${utcTs(dateOnly(addDays(r.to, 1)))}`;
const instants = (r: Range) => ({ from: dayStart(r.from), to: dayStart(addDays(r.to, 1)) });
const dayKey = (col: string) => Prisma.raw(`to_char(${col}, 'YYYY-MM-DD')`);
const VALID_TIME = Prisma.raw(`a."startTime" ~ '^[0-2][0-9]:[0-5][0-9]$'`);

/** Ledger descriptions that are money the salon earned from customers. */
const REVENUE_TYPES = new Set(["booking", "no_show", "late_cancel"]);

// ---------------------------------------------------------------------------
// Shared figures
// ---------------------------------------------------------------------------

const statusByDay = (ids: string[], r: Range) =>
  prisma.$queryRaw<Array<{ day: string; status: AppointmentStatus; n: number; total: number }>>`
    SELECT ${dayKey(`a."appointmentDate"`)} AS day, a.status, COUNT(*)::int AS n,
           COALESCE(SUM(a."totalMinor" - a."discountMinor") FILTER (WHERE a.status = 'COMPLETED'), 0)::float AS total
    FROM appointments a
    WHERE ${inSalons(`a."salonId"`, ids)} AND ${onDays(`a."appointmentDate"`, r)}
    GROUP BY 1, 2`;

const moneyOf = async (ids: string[], r: Range) => {
  const m = await getSalonMoneyRange({ salonIds: ids, ...instants(r) });
  const counterByDay = new Map(m.counter.map((c) => [c.day, c.v]));
  const platformByDay = new Map<string, number>();
  const byType = new Map<string, number>();
  for (const row of m.platform) {
    const type = typeOf(row.description);
    byType.set(type, (byType.get(type) ?? 0) + row.v);
    if (REVENUE_TYPES.has(type)) platformByDay.set(row.day, (platformByDay.get(row.day) ?? 0) + row.v);
  }
  const counterMinor = sum(m.counter.map((c) => c.v));
  const platformMinor = sum([...platformByDay.values()]);
  return { raw: m, counterByDay, platformByDay, byType, counterMinor, platformMinor, revenueMinor: counterMinor + platformMinor };
};

const overviewFigures = async (ids: string[], r: Range) => {
  const fromDate = utcTs(dateOnly(r.from));
  const [byStatus, money, customers, rating] = await Promise.all([
    statusByDay(ids, r),
    moneyOf(ids, r),
    prisma.$queryRaw<Array<{ fresh: number; returning: number }>>`
      WITH firsts AS (
        SELECT a."customerId", MIN(a."appointmentDate") AS first
        FROM appointments a
        WHERE ${inSalons(`a."salonId"`, ids)} AND a.status <> 'CANCELLED'
        GROUP BY 1
      ), seen AS (
        SELECT DISTINCT a."customerId"
        FROM appointments a
        WHERE ${inSalons(`a."salonId"`, ids)} AND ${onDays(`a."appointmentDate"`, r)} AND a.status <> 'CANCELLED'
      )
      SELECT COUNT(*) FILTER (WHERE f.first >= ${fromDate})::int AS fresh,
             COUNT(*) FILTER (WHERE f.first < ${fromDate})::int AS returning
      FROM seen s JOIN firsts f ON f."customerId" = s."customerId"`,
    prisma.review.aggregate({
      where: {
        salonId: { in: ids },
        status: ReviewStatus.PUBLISHED,
        createdAt: { gte: instants(r).from, lt: instants(r).to },
      },
      _avg: { rating: true },
      _count: true,
    }),
  ]);
  const count = (status?: AppointmentStatus) =>
    sum(byStatus.filter((x) => !status || x.status === status).map((x) => x.n));
  const completed = count(AppointmentStatus.COMPLETED);
  const noShows = count(AppointmentStatus.NO_SHOW);
  const cancelled = count(CANCELLED);
  const bookings = count();
  const completedTotal = sum(byStatus.map((x) => x.total));
  return {
    byStatus,
    money,
    bookings,
    completed,
    cancelled,
    noShows,
    avgTicketMinor: completed ? Math.round(completedTotal / completed) : 0,
    newCustomers: customers[0]?.fresh ?? 0,
    returning: customers[0]?.returning ?? 0,
    noShowRate: pct(noShows, bookings - cancelled),
    rating: rating._count ? Math.round((rating._avg.rating ?? 0) * 10) / 10 : null,
    reviews: rating._count,
  };
};

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

const overview = async (c: Ctx) => {
  const [cur, prev] = await Promise.all([
    overviewFigures(c.salonIds, c.range),
    c.prev ? overviewFigures(c.salonIds, c.prev) : Promise.resolve(null),
  ]);
  const kpi = (id: string, label: string, unit: Unit, good: "up" | "down", pick: (f: typeof cur) => number | null): Kpi => ({
    id,
    label,
    unit,
    goodDirection: good,
    value: pick(cur),
    ...(prev ? { previous: pick(prev) } : {}),
  });
  const bookingsOn = (day: string) => sum(cur.byStatus.filter((x) => x.day === day).map((x) => x.n));
  const completedOn = (day: string) =>
    sum(cur.byStatus.filter((x) => x.day === day && x.status === AppointmentStatus.COMPLETED).map((x) => x.n));
  return {
    kpis: [
      kpi("revenue", "Revenue", "minor", "up", (f) => f.money.revenueMinor),
      kpi("bookings", "Bookings", "count", "up", (f) => f.bookings),
      kpi("completed", "Completed", "count", "up", (f) => f.completed),
      kpi("avgTicket", "Average ticket", "minor", "up", (f) => f.avgTicketMinor),
      kpi("newCustomers", "New customers", "count", "up", (f) => f.newCustomers),
      kpi("returning", "Returning customers", "count", "up", (f) => f.returning),
      kpi("noShowRate", "No-show rate", "percent", "down", (f) => f.noShowRate),
      kpi("rating", "Rating", "count", "up", (f) => f.rating),
    ],
    revenue: {
      counterMinor: cur.money.counterMinor,
      platformMinor: cur.money.platformMinor,
      totalMinor: cur.money.revenueMinor,
    },
    cancelled: cur.cancelled,
    reviews: cur.reviews,
    series: c.range.days.map((day) => ({
      day,
      bookings: bookingsOn(day),
      completed: completedOn(day),
      counter: cur.money.counterByDay.get(day) ?? 0,
      platform: cur.money.platformByDay.get(day) ?? 0,
      revenue: (cur.money.counterByDay.get(day) ?? 0) + (cur.money.platformByDay.get(day) ?? 0),
    })),
    ...(prev && c.prev
      ? {
          previousSeries: c.prev.days.map((day) => ({
            day,
            revenue: (prev.money.counterByDay.get(day) ?? 0) + (prev.money.platformByDay.get(day) ?? 0),
          })),
        }
      : {}),
  };
};

const LEAD_BUCKETS = ["Under 2 h", "2–24 h", "1–3 days", "3–7 days", "Over 7 days"];

const bookings = async (c: Ctx) => {
  const ids = c.salonIds;
  const r = c.range;
  const [byStatus, heat, lead, channels, reasons] = await Promise.all([
    statusByDay(ids, r),
    prisma.$queryRaw<Array<{ dow: number; hour: number; n: number }>>`
      SELECT EXTRACT(ISODOW FROM a."appointmentDate")::int AS dow,
             substring(a."startTime", 1, 2)::int AS hour, COUNT(*)::int AS n
      FROM appointments a
      WHERE ${inSalons(`a."salonId"`, ids)} AND ${onDays(`a."appointmentDate"`, r)}
        AND a.status <> 'CANCELLED' AND ${VALID_TIME}
      GROUP BY 1, 2`,
    prisma.$queryRaw<Array<{ bucket: number; n: number }>>`
      WITH t AS (
        SELECT EXTRACT(EPOCH FROM (
                 (a."appointmentDate"::date + a."startTime"::time)
                 - ((a."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka')
               )) / 3600 AS h
        FROM appointments a
        WHERE ${inSalons(`a."salonId"`, ids)} AND ${onDays(`a."appointmentDate"`, r)}
          AND a.status <> 'CANCELLED' AND ${VALID_TIME}
      )
      SELECT CASE WHEN h < 2 THEN 0 WHEN h < 24 THEN 1 WHEN h < 72 THEN 2 WHEN h < 168 THEN 3 ELSE 4 END AS bucket,
             COUNT(*)::int AS n
      FROM t GROUP BY 1`,
    prisma.appointment.groupBy({
      by: ["bookedVia"],
      where: {
        salonId: { in: ids },
        appointmentDate: { gte: dateOnly(r.from), lt: dateOnly(addDays(r.to, 1)) },
        status: { not: CANCELLED },
      },
      _count: true,
    }),
    prisma.$queryRaw<Array<{ reason: string; n: number }>>`
      SELECT COALESCE(NULLIF(lower(trim(a."cancellationReason")), ''), '(no reason given)') AS reason, COUNT(*)::int AS n
      FROM appointments a
      WHERE ${inSalons(`a."salonId"`, ids)} AND ${onDays(`a."appointmentDate"`, r)} AND a.status = 'CANCELLED'
      GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
  ]);

  const statuses = [...new Set(byStatus.map((x) => x.status))].sort();
  // Monday first; hours 0–23.
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const h of heat) if (h.dow >= 1 && h.dow <= 7 && h.hour >= 0 && h.hour < 24) grid[h.dow - 1][h.hour] += h.n;
  const total = sum(byStatus.map((x) => x.n));
  const cancelled = sum(byStatus.filter((x) => x.status === CANCELLED).map((x) => x.n));

  return {
    kpis: [
      { id: "bookings", label: "Bookings", value: total, unit: "count", goodDirection: "up" },
      { id: "cancelled", label: "Cancelled", value: cancelled, unit: "count", goodDirection: "down" },
      { id: "cancelRate", label: "Cancellation rate", value: pct(cancelled, total), unit: "percent", goodDirection: "down" },
    ] satisfies Kpi[],
    statuses,
    perDay: r.days.map((day) => ({
      day,
      ...Object.fromEntries(statuses.map((s) => [s, byStatus.find((x) => x.day === day && x.status === s)?.n ?? 0])),
      total: sum(byStatus.filter((x) => x.day === day).map((x) => x.n)),
    })),
    heatmap: { rows: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], grid },
    leadTime: LEAD_BUCKETS.map((label, i) => ({ key: String(i), label, value: lead.find((l) => l.bucket === i)?.n ?? 0 })),
    channels: channels.map((ch) => ({ key: ch.bookedVia, value: ch._count })),
    cancellationReasons: reasons,
  };
};

const services = async (c: Ctx) => {
  const ids = c.salonIds;
  const [rows, never] = await Promise.all([
    prisma.$queryRaw<Array<{ name: string; category: string; branches: number; bookings: number; completed: number; revenue: number }>>`
      SELECT min(sv.name) AS name, min(sv.category::text) AS category, COUNT(DISTINCT sv."salonId")::int AS branches,
             COUNT(*)::int AS bookings,
             COUNT(*) FILTER (WHERE a.status = 'COMPLETED')::int AS completed,
             COALESCE(SUM(a."totalMinor" - a."discountMinor") FILTER (WHERE a.status = 'COMPLETED'), 0)::float AS revenue
      FROM appointments a JOIN services sv ON sv.id = a."serviceId"
      WHERE ${inSalons(`a."salonId"`, ids)} AND ${onDays(`a."appointmentDate"`, c.range)} AND a.status <> 'CANCELLED'
      GROUP BY lower(trim(sv.name))
      ORDER BY 6 DESC, 4 DESC`,
    prisma.$queryRaw<Array<{ serviceId: string; name: string; salonName: string; priceMinor: number }>>`
      SELECT sv.id AS "serviceId", sv.name, s.name AS "salonName", sv."priceMinor"
      FROM services sv JOIN salons s ON s.id = sv."salonId"
      WHERE ${inSalons(`sv."salonId"`, ids)} AND sv."isDeleted" = false AND sv."isActive" = true
        AND NOT EXISTS (
          SELECT 1 FROM appointments a
          WHERE a."serviceId" = sv.id AND a.status <> 'CANCELLED' AND ${onDays(`a."appointmentDate"`, c.range)}
        )
      ORDER BY sv.name, s.name
      LIMIT 200`,
  ]);
  const totalRevenue = sum(rows.map((r) => r.revenue));
  return {
    rows: rows.map((r) => ({
      name: r.name,
      category: r.category,
      branches: r.branches,
      bookings: r.bookings,
      completed: r.completed,
      revenueMinor: r.revenue,
      avgPriceMinor: r.completed ? Math.round(r.revenue / r.completed) : 0,
      share: pct(r.revenue, totalRevenue),
    })),
    neverBooked: never,
  };
};

const team = async (c: Ctx) => {
  const data = await OwnerTeam.getTeamPerformance(c.user, { salonId: c.salonId ?? undefined, from: c.range.from, to: c.range.to });
  const rows = [...data.rows].sort((a, b) => b.revenueMinor - a.revenueMinor);
  return { totals: data.totals, rows: rows.slice(0, 200), rowCount: rows.length };
};

const customers = async (c: Ctx) => {
  const ids = c.salonIds;
  const today = dhakaDay();
  const cutoff = addDays(today, -60);
  const cohortTo = c.range.to < cutoff ? c.range.to : cutoff;
  const [weekly, retention, lapsed, top] = await Promise.all([
    prisma.$queryRaw<Array<{ week: string; fresh: number; returning: number }>>`
      WITH firsts AS (
        SELECT a."customerId", MIN(a."appointmentDate") AS first
        FROM appointments a WHERE ${inSalons(`a."salonId"`, ids)} AND a.status <> 'CANCELLED' GROUP BY 1
      ), visits AS (
        SELECT DISTINCT a."customerId", date_trunc('week', a."appointmentDate") AS wk
        FROM appointments a
        WHERE ${inSalons(`a."salonId"`, ids)} AND ${onDays(`a."appointmentDate"`, c.range)} AND a.status <> 'CANCELLED'
      )
      SELECT to_char(v.wk, 'YYYY-MM-DD') AS week,
             COUNT(*) FILTER (WHERE f.first >= v.wk)::int AS fresh,
             COUNT(*) FILTER (WHERE f.first < v.wk)::int AS returning
      FROM visits v JOIN firsts f ON f."customerId" = v."customerId"
      GROUP BY 1 ORDER BY 1`,
    cohortTo < c.range.from
      ? Promise.resolve(null)
      : prisma.$queryRaw<Array<{ cohort: number; retained: number }>>`
      WITH done AS (
        SELECT a."customerId", a."appointmentDate" AS d
        FROM appointments a WHERE ${inSalons(`a."salonId"`, ids)} AND a.status = 'COMPLETED'
      ), firsts AS (SELECT "customerId", MIN(d) AS first FROM done GROUP BY 1)
      SELECT COUNT(*)::int AS cohort,
             COUNT(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM done x
               WHERE x."customerId" = f."customerId" AND x.d > f.first AND x.d <= f.first + interval '60 days'
             ))::int AS retained
      FROM firsts f
      WHERE f.first >= ${utcTs(dateOnly(c.range.from))} AND f.first < ${utcTs(dateOnly(addDays(cohortTo, 1)))}`,
    prisma.$queryRaw<Array<{ customerId: string; name: string; visits: number; spent: number; lastBooking: string }>>`
      SELECT a."customerId", min(u.name) AS name,
             COUNT(*) FILTER (WHERE a.status = 'COMPLETED')::int AS visits,
             COALESCE(SUM(a."totalMinor" - a."discountMinor") FILTER (WHERE a.status = 'COMPLETED'), 0)::float AS spent,
             to_char(MAX(a."appointmentDate") FILTER (WHERE a.status <> 'CANCELLED'), 'YYYY-MM-DD') AS "lastBooking"
      FROM appointments a JOIN users u ON u.id = a."customerId"
      WHERE ${inSalons(`a."salonId"`, ids)}
      GROUP BY 1
      HAVING COUNT(*) FILTER (WHERE a.status = 'COMPLETED') >= 1
         AND MAX(a."appointmentDate") FILTER (WHERE a.status <> 'CANCELLED') < ${utcTs(dateOnly(cutoff))}
      ORDER BY 4 DESC LIMIT 50`,
    prisma.$queryRaw<Array<{ customerId: string; name: string; visits: number; spent: number }>>`
      SELECT a."customerId", min(u.name) AS name, COUNT(*)::int AS visits,
             COALESCE(SUM(a."totalMinor" - a."discountMinor"), 0)::float AS spent
      FROM appointments a JOIN users u ON u.id = a."customerId"
      WHERE ${inSalons(`a."salonId"`, ids)} AND ${onDays(`a."appointmentDate"`, c.range)} AND a.status = 'COMPLETED'
      GROUP BY 1 ORDER BY 4 DESC LIMIT 20`,
  ]);
  const fresh = sum(weekly.map((w) => w.fresh));
  const returning = sum(weekly.map((w) => w.returning));
  const cohort = retention?.[0];
  return {
    kpis: [
      { id: "new", label: "New (customer-weeks)", value: fresh, unit: "count", goodDirection: "up" },
      { id: "returning", label: "Returning (customer-weeks)", value: returning, unit: "count", goodDirection: "up" },
    ] satisfies Kpi[],
    weekly,
    retention60: !cohort
      ? unavailable("First visits in this range are under 60 days old; pick a range that ends before " + cutoff + ".")
      : cohort.cohort === 0
        ? unavailable("No first visits in this range to follow up.")
        : { available: true, cohort: cohort.cohort, retained: cohort.retained, percent: pct(cohort.retained, cohort.cohort), cohortTo },
    lapsed: lapsed.map((l) => ({ customerId: l.customerId, name: l.name, visits: l.visits, spentMinor: l.spent, lastBooking: l.lastBooking })),
    top: top.map((t) => ({ customerId: t.customerId, name: t.name, visits: t.visits, spentMinor: t.spent })),
  };
};

const utilisation = async (c: Ctx) => {
  const ids = c.salonIds;
  const slotDays = Prisma.sql`${inSalons(`sl."salonId"`, ids)} AND ${onDays(`sl.date`, c.range)}`;
  const offered = Prisma.raw(`COUNT(*) FILTER (WHERE sl.status NOT IN ('BLOCKED', 'CANCELLED'))::int`);
  const booked = Prisma.raw(`COUNT(*) FILTER (WHERE sl."isBooked")::int`);
  const [perDay, perCounter, perHour, teamData] = await Promise.all([
    prisma.$queryRaw<Array<{ day: string; offered: number; booked: number }>>`
      SELECT ${dayKey(`sl.date`)} AS day, ${offered} AS offered, ${booked} AS booked
      FROM slots sl WHERE ${slotDays} GROUP BY 1`,
    prisma.$queryRaw<Array<{ counterId: string | null; name: string | null; salonName: string; offered: number; booked: number }>>`
      SELECT sl."counterId", min(ct.name) AS name, min(s.name) AS "salonName", ${offered} AS offered, ${booked} AS booked
      FROM slots sl JOIN salons s ON s.id = sl."salonId" LEFT JOIN counters ct ON ct.id = sl."counterId"
      WHERE ${slotDays}
      GROUP BY sl."salonId", sl."counterId" ORDER BY 4 DESC LIMIT 200`,
    prisma.$queryRaw<Array<{ hour: number; offered: number; booked: number }>>`
      SELECT substring(sl."startTime", 1, 2)::int AS hour, ${offered} AS offered, ${booked} AS booked
      FROM slots sl WHERE ${slotDays} AND sl."startTime" ~ '^[0-2][0-9]:' GROUP BY 1 ORDER BY 1`,
    OwnerTeam.getTeamPerformance(c.user, { salonId: c.salonId ?? undefined, from: c.range.from, to: c.range.to }),
  ]);
  const totalOffered = sum(perDay.map((d) => d.offered));
  const totalBooked = sum(perDay.map((d) => d.booked));
  if (!totalOffered) {
    return { ...unavailable("No slots were open in this range, so there is nothing to fill."), staff: teamData.rows.slice(0, 200) };
  }
  return {
    available: true,
    kpis: [
      { id: "offered", label: "Slots offered", value: totalOffered, unit: "count", goodDirection: "up" },
      { id: "booked", label: "Slots booked", value: totalBooked, unit: "count", goodDirection: "up" },
      { id: "fill", label: "Fill rate", value: pct(totalBooked, totalOffered), unit: "percent", goodDirection: "up" },
    ] satisfies Kpi[],
    perDay: c.range.days.map((day) => {
      const d = perDay.find((x) => x.day === day);
      return { day, offered: d?.offered ?? 0, booked: d?.booked ?? 0, fill: d ? pct(d.booked, d.offered) : null };
    }),
    perCounter: perCounter.map((x) => ({ ...x, name: x.name ?? "No counter", fill: pct(x.booked, x.offered) })),
    perHour: perHour.map((x) => ({ ...x, fill: pct(x.booked, x.offered) })),
    emptyHours: perHour.filter((x) => x.offered > 0 && x.booked === 0).map((x) => x.hour),
    staff: teamData.rows
      .filter((row) => row.availableMinutes !== null)
      .sort((a, b) => (a.utilisation ?? 0) - (b.utilisation ?? 0))
      .slice(0, 200)
      .map((row) => ({
        name: row.name,
        salonName: row.salonName,
        bookedMinutes: row.bookedMinutes,
        availableMinutes: row.availableMinutes,
        utilisation: row.utilisation === null ? null : Math.round(row.utilisation * 1000) / 10,
      })),
  };
};

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const discovery = async (c: Ctx) => {
  const ids = c.salonIds;
  const r = c.range;
  const dayRange = { gte: dateOnly(r.from), lte: dateOnly(r.to) };
  const [viewsTracked, views, online, sources, terms, offered] = await Promise.all([
    prisma.eventDaily.count({ where: { event: "salon_viewed", day: dayRange } }),
    prisma.eventDaily.groupBy({
      by: ["day"],
      where: { event: "salon_viewed", day: dayRange, dimension: { in: ids.map((id) => `salon:${id}`) } },
      _sum: { count: true },
    }),
    prisma.appointment.count({
      where: {
        salonId: { in: ids },
        appointmentDate: { gte: dateOnly(r.from), lt: dateOnly(addDays(r.to, 1)) },
        status: { not: CANCELLED },
        bookedVia: { not: "WALK_IN" },
      },
    }),
    prisma.appointment.groupBy({
      by: ["source"],
      where: {
        salonId: { in: ids },
        appointmentDate: { gte: dateOnly(r.from), lt: dateOnly(addDays(r.to, 1)) },
        status: { not: CANCELLED },
      },
      _count: true,
    }),
    prisma.$queryRaw<Array<{ term: string; searches: number; zero: number }>>`
      SELECT term, SUM(count)::int AS searches, SUM("zeroResults")::int AS zero
      FROM search_query_daily
      WHERE day >= ${r.from}::date AND day <= ${r.to}::date
      GROUP BY 1 ORDER BY 2 DESC LIMIT 300`,
    prisma.service.findMany({
      where: { salonId: { in: ids }, isDeleted: false },
      select: { name: true, category: true },
      distinct: ["name", "category"],
    }),
  ]);

  const viewCount = sum(views.map((v) => v._sum.count ?? 0));
  const ownWords = new Set<string>();
  const ownNames: string[] = [];
  for (const s of offered) {
    const n = norm(s.name);
    ownNames.push(n, norm(s.category));
    for (const w of n.split(" ")) if (w.length > 2) ownWords.add(w);
  }
  // Missed demand: searched terms none of this business's services or
  // categories answer (word overlap either way, normalised).
  const matches = (term: string) => {
    const t = norm(term);
    if (!t) return true;
    if (ownNames.some((n) => n && (n.includes(t) || t.includes(n)))) return true;
    return t.split(" ").some((w) => w.length > 2 && ownWords.has(w));
  };
  const missed = terms.filter((t) => !matches(t.term)).slice(0, 20);
  const views_ = viewsTracked
    ? { available: true as const, value: viewCount }
    : unavailable("Profile views are not being recorded yet.");

  return {
    funnel: [
      { key: "impressions", label: "Seen in search", ...unavailable("Search results are not logged per salon.") },
      { key: "views", label: "Profile views", ...views_ },
      { key: "starts", label: "Booking started", ...unavailable("Booking starts are counted for the whole site, not per salon.") },
      { key: "bookings", label: "Online bookings", available: true as const, value: online },
    ],
    viewsSeries: viewsTracked
      ? r.days.map((day) => ({ day, value: views.find((v) => v.day.toISOString().slice(0, 10) === day)?._sum.count ?? 0 }))
      : null,
    aiMatch: unavailable("AI Match results are not logged per salon yet."),
    missedDemand: terms.length
      ? {
          available: true as const,
          // search_query_daily has no place column: terms are site-wide.
          scope: "site",
          note: "Search terms are recorded for the whole site, not per area.",
          terms: missed,
        }
      : unavailable("No searches were recorded in this range."),
    sources: sources.map((s) => ({ key: s.source, value: s._count })),
  };
};

const money = async (c: Ctx) => {
  if (!c.isOwner) throw new ApiError(StatusCodes.NOT_FOUND, "Not found");
  const [m, closes] = await Promise.all([
    moneyOf(c.salonIds, c.range),
    // Daily closes (Phase 14): the till count against what was expected.
    prisma.dailyClose.findMany({
      where: { salonId: { in: c.salonIds }, date: { gte: dateOnly(c.range.from), lte: dateOnly(c.range.to) } },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        date: true,
        expectedCashMinor: true,
        countedCashMinor: true,
        differenceMinor: true,
        salon: { select: { id: true, name: true } },
      },
    }),
  ]);
  const commissionMinor = m.byType.get("commission") ?? 0;
  const paidOut = sum(m.raw.payouts.map((p) => p.v));
  return {
    kpis: [
      { id: "counter", label: "Counter takings", value: m.counterMinor, unit: "minor", goodDirection: "up" },
      { id: "platform", label: "Platform earnings", value: m.platformMinor, unit: "minor", goodDirection: "up" },
      { id: "commission", label: "Commission", value: -commissionMinor, unit: "minor", goodDirection: "down" },
      { id: "effectiveCommission", label: "Effective commission", value: pct(-commissionMinor, m.revenueMinor), unit: "percent", goodDirection: "down" },
      { id: "paidOut", label: "Paid out", value: paidOut, unit: "minor", goodDirection: "up" },
    ] satisfies Kpi[],
    revenueMinor: m.revenueMinor,
    counterByMethod: m.raw.byMethod.map((x) => ({ key: x.method, valueMinor: x.v, payments: x.n })),
    platformByType: [...m.byType.entries()].map(([key, v]) => ({ key, valueMinor: v })).sort((a, b) => b.valueMinor - a.valueMinor),
    payouts: m.raw.payouts.map((p) => ({ payoutId: p.payoutId, paidAt: p.paidAt, amountMinor: p.v })),
    closes: closes.map((x) => ({
      id: x.id,
      day: x.date.toISOString().slice(0, 10),
      salonId: x.salon.id,
      salonName: x.salon.name,
      expectedCashMinor: x.expectedCashMinor,
      countedCashMinor: x.countedCashMinor,
      differenceMinor: x.differenceMinor,
    })),
    closeDifferenceMinor: sum(closes.map((x) => x.differenceMinor)),
    series: c.range.days.map((day) => ({
      day,
      counter: m.counterByDay.get(day) ?? 0,
      platform: m.platformByDay.get(day) ?? 0,
    })),
  };
};

const BUILDERS: Record<ReportName, (c: Ctx) => Promise<unknown>> = {
  overview,
  bookings,
  services,
  team,
  customers,
  utilisation,
  discovery,
  money,
};

const reportOf = (raw: string): ReportName => {
  if (!(REPORTS as readonly string[]).includes(raw)) throw new ApiError(StatusCodes.NOT_FOUND, "Unknown report");
  return raw as ReportName;
};

export const getOwnerReport = async (user: AccessUser, name: string, query: Query) => {
  const report = reportOf(name);
  const c = await contextOf(user, query);
  const startedAt = Date.now();
  const data = c.salonIds.length ? await BUILDERS[report](c) : null;
  return {
    report,
    from: c.range.from,
    to: c.range.to,
    compare: c.prev ? { from: c.prev.from, to: c.prev.to } : null,
    salonId: c.salonId,
    branches: c.salonIds.length,
    tookMs: Date.now() - startedAt,
    data,
  };
};

// ---------------------------------------------------------------------------
// CSV: each report's main table
// ---------------------------------------------------------------------------

type Line = Record<string, unknown>;
type CsvSpec = { columns: CsvColumn<Line>[]; rows: Line[] };
const col = (header: string, key: string, money = false): CsvColumn<Line> => ({ header, value: (r) => r[key], money });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const csvSpec = (report: ReportName, data: any): CsvSpec => {
  if (!data) return { columns: [col("note", "note")], rows: [{ note: "No branches in scope" }] };
  switch (report) {
    case "overview":
      return {
        columns: [col("day", "day"), col("bookings", "bookings"), col("completed", "completed"), col("counter_taka", "counter", true), col("platform_taka", "platform", true), col("revenue_taka", "revenue", true)],
        rows: data.series,
      };
    case "bookings":
      return {
        columns: [col("day", "day"), ...data.statuses.map((s: string) => col(s.toLowerCase(), s)), col("total", "total")],
        rows: data.perDay,
      };
    case "services":
      return {
        columns: [col("service", "name"), col("category", "category"), col("branches", "branches"), col("bookings", "bookings"), col("completed", "completed"), col("revenue_taka", "revenueMinor", true), col("avg_price_taka", "avgPriceMinor", true), col("revenue_share_percent", "share")],
        rows: data.rows,
      };
    case "team":
      return {
        columns: [col("branch", "salonName"), col("stylist", "name"), col("bookings", "bookings"), col("completed", "completed"), col("no_shows", "noShows"), col("revenue_taka", "revenueMinor", true), col("rating", "rating")],
        rows: data.rows,
      };
    case "customers":
      return { columns: [col("week_starting", "week"), col("new", "fresh"), col("returning", "returning")], rows: data.weekly };
    case "utilisation":
      return data.available === false
        ? { columns: [col("note", "reason")], rows: [{ reason: data.reason }] }
        : { columns: [col("day", "day"), col("offered", "offered"), col("booked", "booked"), col("fill_percent", "fill")], rows: data.perDay };
    case "discovery":
      return data.missedDemand.available
        ? { columns: [col("term", "term"), col("searches", "searches"), col("zero_results", "zero")], rows: data.missedDemand.terms }
        : { columns: [col("note", "reason")], rows: [{ reason: data.missedDemand.reason }] };
    case "money":
      return { columns: [col("day", "day"), col("counter_taka", "counter", true), col("platform_taka", "platform", true)], rows: data.series };
  }
};

const json = catchAsync(async (req: Request, res: Response) => {
  const data = await getOwnerReport(withAccessCache(req), String(req.params.report), req.query);
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Report", data });
});

const csv = catchAsync(async (req: Request, res: Response) => {
  const result = await getOwnerReport(withAccessCache(req), String(req.params.report), req.query);
  const spec = csvSpec(result.report, result.data);
  await streamCsv(res, {
    filename: `${result.report}-${result.from}-to-${result.to}.csv`,
    columns: spec.columns,
    // The business's own figures; customer names only appear in on-screen lists.
    showPii: true,
    fetchBatch: async (after, take) => {
      const start = after ? spec.rows.indexOf(after) + 1 : 0;
      return spec.rows.slice(start, start + take);
    },
  });
});

export const OwnerReports = { json, csv };
