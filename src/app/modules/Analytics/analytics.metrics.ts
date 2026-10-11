import { Prisma } from "@prisma/client";
import prisma from "../../shared/prisma";
import { SettlementEarnings, type DailyMoney } from "../Settlement/settlement.earnings";
import { between, DAY_MS, daySql, dhakaDay, utcTs } from "./analytics.days";
import { latencyBucket } from "./analytics.capture";
import { EVENT_ALLOW_LIST, EVENT_NAMES, primaryKey, type EventName } from "./analytics.events";

/**
 * The metric dictionary: one definition per number the back office shows.
 * Reports, rollups and exports read only from here.
 *
 * Rules every entry follows:
 *   - days are Asia/Dhaka dates (`analytics.days.ts`);
 *   - test salons and test customers are left out unless `includeTest`;
 *   - money comes only from `Settlement/settlement.earnings.ts`.
 *
 * Kinds:
 *   daily     computed per day from the source tables, stored in `metric_daily`
 *             (the `includeTest` variant under a `*`-prefixed dimension). A range
 *             is the sum of its days, or `period()` when a sum is meaningless
 *             (medians).
 *   snapshot  a balance that is only true "now"; stored once a day at the Dhaka
 *             day rollover as the closing value of the day before.
 *   captured  counted live as it happens (`analytics.capture.ts`); never
 *             recomputed, has no test variant.
 *   ratio     num ÷ den × scale, from two other metrics, per day and per range.
 *   quantile  read from a latency histogram (dimensions `le:<ms>`).
 *   period    only meaningful over a whole range; no daily series.
 *   table     a report table rather than one number.
 *
 * `testless` metrics have no test data in them (visitors, events, searches,
 * try-on), so they are stored once. `volatile` ones read tables that are
 * purged: their stored value never goes down. `filterable` ones honour the
 * report's `area`/`channel` filters (computed live when either is set).
 */

export type Unit = "count" | "minor" | "percent" | "hours" | "days";
export type MetricOpts = { includeTest: boolean; area?: string; channel?: string };
export type MetricRow = { day: string; dimension: string; value: number };

type Base = {
  id: string;
  label: string;
  definition: string;
  unit: Unit;
  goodDirection: "up" | "down";
  /** A part of a ratio or quantile, not shown on its own. */
  hidden?: boolean;
};

type RangeFn<T> = (from: Date, to: Date, opts: MetricOpts) => Promise<T>;

export type DailyMetric = Base & {
  kind: "daily";
  compute: RangeFn<MetricRow[]>;
  period?: RangeFn<number | null>;
  filterable?: boolean;
  testless?: boolean;
  volatile?: boolean;
};
export type SnapshotMetric = Base & {
  kind: "snapshot";
  compute: (opts: MetricOpts) => Promise<Array<{ dimension: string; value: number }>>;
};
export type CapturedMetric = Base & { kind: "captured" };
export type RatioMetric = Base & { kind: "ratio"; num: string; den: string; scale: number };
export type QuantileMetric = Base & { kind: "quantile"; hist: string; q: number };
export type PeriodMetric = Base & { kind: "period"; period: RangeFn<number | null> };
export type TableMetric = Base & { kind: "table"; table: RangeFn<unknown> };

export type Metric =
  | DailyMetric
  | SnapshotMetric
  | CapturedMetric
  | RatioMetric
  | QuantileMetric
  | PeriodMetric
  | TableMetric;

// ---------------------------------------------------------------------------
// SQL helpers

const raw = Prisma.raw;
type Raw = { day: string; v: number } & Record<string, unknown>;
const rows = (sql: Prisma.Sql) => prisma.$queryRaw<Raw[]>(sql);
const one = async (sql: Prisma.Sql) => (await prisma.$queryRaw<Array<{ v: number | null }>>(sql))[0]?.v ?? null;

const APPT = Prisma.sql`appointments a JOIN salons s ON s.id = a."salonId" JOIN users u ON u.id = a."customerId"`;
const COMPLETED_AT = `COALESCE(a."completedAt", a."appointmentDate")`;

/** Bookings at test salons or by test customers. */
const real = (o: MetricOpts) =>
  o.includeTest ? Prisma.empty : Prisma.sql`AND s."isTest" = false AND u."isTest" = false`;
const realSalon = (o: MetricOpts) => (o.includeTest ? Prisma.empty : Prisma.sql`AND s."isTest" = false`);
/** For tables whose user link is optional (LEFT JOIN users u). */
const realUser = (o: MetricOpts) =>
  o.includeTest ? Prisma.empty : Prisma.sql`AND COALESCE(u."isTest", false) = false`;
const narrow = (o: MetricOpts) =>
  Prisma.sql`${o.area ? Prisma.sql`AND lower(trim(s.area)) = ${o.area.trim().toLowerCase()}` : Prisma.empty}
    ${o.channel ? Prisma.sql`AND a."bookedVia"::text = ${o.channel}` : Prisma.empty}`;

/** Dhaka calendar date of a timestamp column, as a SQL `date`. */
const dhakaDate = (col: string) => raw(`((${col} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka')::date`);

/** For `@db.Date` tables: [first, last] Dhaka days of an instant range. */
const dayRange = (col: string, from: Date, to: Date) =>
  Prisma.sql`${raw(col)} >= ${dhakaDay(from)}::date AND ${raw(col)} <= ${dhakaDay(new Date(to.getTime() - 1))}::date`;

/**
 * Raw grouped rows → metric rows: a "" total per day plus one `key:value`
 * row per listed column. Zero values are dropped (absent = 0).
 */
const spread = (input: Raw[], keys: string[] = [], pick: (r: Raw) => number = (r) => Number(r.v)) => {
  const acc = new Map<string, number>();
  const add = (day: string, dim: string, v: number) => acc.set(`${day}|${dim}`, (acc.get(`${day}|${dim}`) ?? 0) + v);
  for (const r of input) {
    const v = pick(r);
    if (!v) continue;
    add(r.day, "", v);
    for (const k of keys) add(r.day, `${k}:${r[k] ?? "UNKNOWN"}`, v);
  }
  return [...acc].map(([key, value]): MetricRow => {
    const cut = key.indexOf("|");
    return { day: key.slice(0, cut), dimension: key.slice(cut + 1), value };
  });
};

const plain = (input: Raw[]): MetricRow[] =>
  input.filter((r) => r.v !== null && Number(r.v) !== 0).map((r) => ({ day: r.day, dimension: "", value: Number(r.v) }));

// Money: one call per range serves GMV, completed count, commission and top-ups.
const moneyMemo = new Map<string, { at: number; p: Promise<DailyMoney[]> }>();
const dailyMoney = (from: Date, to: Date, o: MetricOpts) => {
  const key = `${from.toISOString()}|${to.toISOString()}|${o.includeTest}|${o.area ?? ""}|${o.channel ?? ""}`;
  const hit = moneyMemo.get(key);
  if (hit && Date.now() - hit.at < 15_000) return hit.p;
  const p = SettlementEarnings.getDailyMoney({ from, to, ...o });
  p.catch(() => moneyMemo.delete(key));
  moneyMemo.set(key, { at: Date.now(), p });
  if (moneyMemo.size > 64) moneyMemo.delete(moneyMemo.keys().next().value as string);
  return p;
};
const money =
  (pick: (m: DailyMoney) => number): RangeFn<MetricRow[]> =>
  async (from, to, o) =>
    (await dailyMoney(from, to, o))
      .filter((m) => pick(m) !== 0)
      .map((m) => ({ day: m.day, dimension: "", value: pick(m) }));

const balances = (o: MetricOpts) => SettlementEarnings.getPlatformEarnings({ includeTest: o.includeTest });

// ---------------------------------------------------------------------------
// Shared queries

const bookingsCreated: RangeFn<Raw[]> = (from, to, o) => rows(Prisma.sql`
  SELECT ${daySql(`a."createdAt"`)} AS day, a."bookedVia"::text AS channel, a.source::text AS source,
         COUNT(*)::int AS v
  FROM ${APPT}
  WHERE ${between(`a."createdAt"`, from, to)} ${real(o)} ${narrow(o)}
  GROUP BY 1, 2, 3`);

const noShows: RangeFn<Raw[]> = (from, to, o) => rows(Prisma.sql`
  SELECT ${daySql(`a."appointmentDate"`)} AS day,
         COUNT(*) FILTER (WHERE a.status = 'NO_SHOW')::int AS v, COUNT(*)::int AS base
  FROM ${APPT}
  WHERE a.status IN ('COMPLETED', 'NO_SHOW') AND ${between(`a."appointmentDate"`, from, to)} ${real(o)} ${narrow(o)}
  GROUP BY 1`);

const LEAD_DAYS = Prisma.sql`(${dhakaDate(`a."appointmentDate"`)} - ${dhakaDate(`a."createdAt"`)})`;
const leadTimeWhere = (from: Date, to: Date, o: MetricOpts) =>
  Prisma.sql`${between(`a."createdAt"`, from, to)} AND a."bookedVia" <> 'WALK_IN' ${real(o)} ${narrow(o)}`;

const signups: RangeFn<Raw[]> = (from, to, o) => rows(Prisma.sql`
  SELECT ${daySql(`u."createdAt"`)} AS day, u.role::text AS role, COUNT(*)::int AS v,
         COUNT(*) FILTER (WHERE u."emailVerified")::int AS verified
  FROM users u
  WHERE ${between(`u."createdAt"`, from, to)} ${o.includeTest ? Prisma.empty : Prisma.sql`AND u."isTest" = false`}
  GROUP BY 1, 2`);

const APPROVE_HOURS = Prisma.sql`EXTRACT(EPOCH FROM (s."approvedAt" - s."createdAt")) / 3600`;

const slots: RangeFn<Raw[]> = (from, to, o) => rows(Prisma.sql`
  SELECT ${daySql(`sl.date`)} AS day,
         COUNT(*) FILTER (WHERE sl.status IN ('BOOKED', 'COMPLETED'))::int AS v,
         COUNT(*) FILTER (WHERE sl.status IN ('AVAILABLE', 'BOOKED', 'COMPLETED'))::int AS cap
  FROM slots sl JOIN salons s ON s.id = sl."salonId"
  WHERE ${between(`sl.date`, from, to)} ${realSalon(o)}
    ${o.area ? Prisma.sql`AND lower(trim(s.area)) = ${o.area.trim().toLowerCase()}` : Prisma.empty}
  GROUP BY 1`);

const topups: RangeFn<Raw[]> = (from, to, o) => rows(Prisma.sql`
  SELECT ${daySql(`i."createdAt"`)} AS day,
         COUNT(*) FILTER (WHERE i.status = 'SUCCESS')::int AS v,
         COUNT(*) FILTER (WHERE i.status IN ('SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED'))::int AS finished
  FROM payment_intents i JOIN users u ON u.id = i."userId"
  WHERE i.purpose = 'WALLET_TOPUP' AND ${between(`i."createdAt"`, from, to)} ${realUser(o)}
  GROUP BY 1`);

const searches = (from: Date, to: Date) => rows(Prisma.sql`
  SELECT day::text AS day, surface, SUM(count)::int AS v, SUM("zeroResults")::int AS zero
  FROM search_query_daily WHERE ${dayRange("day", from, to)}
  GROUP BY 1, 2`);

const tryonJobs = (from: Date, to: Date) => rows(Prisma.sql`
  SELECT ${daySql(`j."createdAt"`)} AS day, j.status::text AS status,
         COALESCE(j."errorCode", 'UNKNOWN') AS code, j."latencyMs" AS ms, 1 AS v
  FROM hair_tryon_jobs j
  WHERE j.status IN ('DONE', 'FAILED') AND ${between(`j."createdAt"`, from, to)}`);

const tickets: RangeFn<Raw[]> = (from, to, o) => rows(Prisma.sql`
  SELECT ${daySql(`t."createdAt"`)} AS day, COUNT(*)::int AS v
  FROM support_tickets t LEFT JOIN users u ON u.id = t."userId"
  WHERE ${between(`t."createdAt"`, from, to)} ${realUser(o)}
  GROUP BY 1`);

const ticketHours = (col: "firstResponseAt" | "resolvedAt") => {
  const hours = raw(`EXTRACT(EPOCH FROM (t."${col}" - t."createdAt")) / 3600`);
  const where = (from: Date, to: Date, o: MetricOpts) =>
    Prisma.sql`t."${raw(col)}" IS NOT NULL AND ${between(`t."createdAt"`, from, to)} ${realUser(o)}`;
  return {
    compute: (async (from, to, o) =>
      plain(
        await rows(Prisma.sql`
          SELECT ${daySql(`t."createdAt"`)} AS day, percentile_cont(0.5) WITHIN GROUP (ORDER BY ${hours})::float AS v
          FROM support_tickets t LEFT JOIN users u ON u.id = t."userId"
          WHERE ${where(from, to, o)} GROUP BY 1`),
      )) as RangeFn<MetricRow[]>,
    period: ((from, to, o) =>
      one(Prisma.sql`
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ${hours})::float AS v
        FROM support_tickets t LEFT JOIN users u ON u.id = t."userId"
        WHERE ${where(from, to, o)}`)) as RangeFn<number | null>,
  };
};

const reviews: RangeFn<Raw[]> = (from, to, o) => rows(Prisma.sql`
  SELECT ${daySql(`r."createdAt"`)} AS day, COUNT(*)::int AS v, SUM(r.rating)::int AS stars,
         COUNT(*) FILTER (WHERE r.status = 'HIDDEN')::int AS hidden
  FROM reviews r JOIN salons s ON s.id = r."salonId" JOIN users u ON u.id = r."customerId"
  WHERE ${between(`r."createdAt"`, from, to)} ${real(o)}
  GROUP BY 1`);

const funnelEvent = (event: EventName): DailyMetric => {
  const key = primaryKey(event);
  const keys: readonly { key: string }[] = EVENT_ALLOW_LIST[event];
  return {
    id: `funnel.${event}`,
    kind: "daily",
    testless: true,
    volatile: true,
    label: `Event: ${event.replace(/_/g, " ")}`,
    definition: `Count of allow-listed "${event}" events from POST /events, per Dhaka day${
      keys.length ? `; dimensions ${keys.map((k) => `${k.key}:`).join(", ")}` : ""
    }. Visitors with Do Not Track / Global Privacy Control and bots are never counted.`,
    unit: "count",
    goodDirection: "up",
    compute: async (from, to) => {
      const found = await rows(Prisma.sql`
        SELECT day::text AS day, dimension, SUM(count)::int AS v
        FROM event_daily WHERE event = ${event} AND ${dayRange("day", from, to)}
        GROUP BY 1, 2`);
      const out = new Map<string, number>();
      const add = (k: string, v: number) => out.set(k, (out.get(k) ?? 0) + v);
      for (const r of found) {
        const dim = String(r.dimension);
        const isPrimary = key === "" ? dim === "" : dim.startsWith(`${key}:`);
        if (isPrimary) add(`${r.day}|`, Number(r.v));
        // Per-salon rows would be one per salon per day: the total is enough.
        if (dim && key !== "salon") add(`${r.day}|${dim}`, Number(r.v));
      }
      return [...out].map(([k, value]) => {
        const cut = k.indexOf("|");
        return { day: k.slice(0, cut), dimension: k.slice(cut + 1), value };
      });
    },
  };
};

// ---------------------------------------------------------------------------
// The dictionary

export const METRICS: Metric[] = [
  // Money
  {
    id: "gmv.completedMinor",
    kind: "daily",
    filterable: true,
    label: "Completed GMV",
    definition:
      "Sum of totalMinor of COMPLETED bookings, by the Dhaka day they were completed (completedAt; appointment date for rows completed before it was stamped). Same figure as grossBookingsMinor.",
    unit: "minor",
    goodDirection: "up",
    compute: money((m) => m.gmvMinor),
  },
  {
    id: "commission.minor",
    kind: "daily",
    filterable: true,
    label: "Commission",
    definition: "Sum of PLATFORM_REVENUE ledger entries by createdAt.",
    unit: "minor",
    goodDirection: "up",
    compute: money((m) => m.commissionMinor),
  },
  {
    id: "takeRate",
    kind: "ratio",
    num: "commission.minor",
    den: "gmv.completedMinor",
    scale: 100,
    label: "Take rate",
    definition: "Commission ÷ completed GMV.",
    unit: "percent",
    goodDirection: "up",
  },
  {
    id: "ticket.avgMinor",
    kind: "ratio",
    num: "gmv.completedMinor",
    den: "bookings.completed",
    scale: 1,
    label: "Average ticket",
    definition: "Completed GMV ÷ completed bookings.",
    unit: "minor",
    goodDirection: "up",
  },

  // Bookings
  {
    id: "bookings.created",
    kind: "daily",
    filterable: true,
    label: "Bookings created",
    definition: "Bookings by createdAt, any status. Dimensions channel:<WEB|ASSISTANT|WALK_IN> and source:<PLATFORM|SALON_DIRECT>.",
    unit: "count",
    goodDirection: "up",
    compute: async (from, to, o) => spread(await bookingsCreated(from, to, o), ["channel", "source"]),
  },
  {
    id: "bookings.completed",
    kind: "daily",
    filterable: true,
    label: "Bookings completed",
    definition: "COMPLETED bookings by the day they were completed (the same rows as completed GMV).",
    unit: "count",
    goodDirection: "up",
    compute: money((m) => m.completed),
  },
  {
    id: "bookings.cancelled",
    kind: "daily",
    filterable: true,
    hidden: true,
    label: "Bookings cancelled",
    definition: "Bookings created that day that are now CANCELLED. Dimension by:<CUSTOMER|SALON|ADMIN|SYSTEM|UNKNOWN>.",
    unit: "count",
    goodDirection: "down",
    compute: async (from, to, o) => {
      const found = await rows(Prisma.sql`
        SELECT ${daySql(`a."createdAt"`)} AS day, COALESCE(a."cancelledBy"::text, 'UNKNOWN') AS by, COUNT(*)::int AS v
        FROM ${APPT}
        WHERE a.status = 'CANCELLED' AND ${between(`a."createdAt"`, from, to)} ${real(o)} ${narrow(o)}
        GROUP BY 1, 2`);
      return spread(found, ["by"]);
    },
  },
  {
    id: "cancel.rate",
    kind: "ratio",
    num: "bookings.cancelled",
    den: "bookings.created",
    scale: 100,
    label: "Cancellation rate",
    definition: "Cancelled ÷ created, both by the day the booking was created. Dimension by: (who cancelled).",
    unit: "percent",
    goodDirection: "down",
  },
  {
    id: "noshow.count",
    kind: "daily",
    filterable: true,
    hidden: true,
    label: "No-shows",
    definition: "NO_SHOW bookings by appointment date.",
    unit: "count",
    goodDirection: "down",
    compute: async (from, to, o) => plain(await noShows(from, to, o)),
  },
  {
    id: "noshow.base",
    kind: "daily",
    filterable: true,
    hidden: true,
    label: "Attended or no-show",
    definition: "COMPLETED + NO_SHOW bookings by appointment date.",
    unit: "count",
    goodDirection: "up",
    compute: async (from, to, o) => spread(await noShows(from, to, o), [], (r) => Number(r.base)),
  },
  {
    id: "noshow.rate",
    kind: "ratio",
    num: "noshow.count",
    den: "noshow.base",
    scale: 100,
    label: "No-show rate",
    definition: "NO_SHOW ÷ (COMPLETED + NO_SHOW), by appointment date.",
    unit: "percent",
    goodDirection: "down",
  },
  {
    id: "leadTime.medianDays",
    kind: "daily",
    filterable: true,
    label: "Median lead time",
    definition: "Median Dhaka calendar days from createdAt to the appointment date, walk-ins excluded, by created day.",
    unit: "days",
    goodDirection: "up",
    compute: async (from, to, o) =>
      plain(
        await rows(Prisma.sql`
          SELECT ${daySql(`a."createdAt"`)} AS day, percentile_cont(0.5) WITHIN GROUP (ORDER BY ${LEAD_DAYS})::float AS v
          FROM ${APPT} WHERE ${leadTimeWhere(from, to, o)} GROUP BY 1`),
      ),
    period: (from, to, o) =>
      one(Prisma.sql`
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ${LEAD_DAYS})::float AS v
        FROM ${APPT} WHERE ${leadTimeWhere(from, to, o)}`),
  },
  {
    id: "slots.booked",
    kind: "daily",
    hidden: true,
    label: "Slots booked",
    definition: "Slots BOOKED or COMPLETED, by slot date.",
    unit: "count",
    goodDirection: "up",
    compute: async (from, to, o) => plain(await slots(from, to, o)),
  },
  {
    id: "slots.capacity",
    kind: "daily",
    hidden: true,
    label: "Slots offered",
    definition: "Slots AVAILABLE, BOOKED or COMPLETED (not blocked or cancelled), by slot date.",
    unit: "count",
    goodDirection: "up",
    compute: async (from, to, o) => spread(await slots(from, to, o), [], (r) => Number(r.cap)),
  },
  {
    id: "slots.fillRate",
    kind: "ratio",
    num: "slots.booked",
    den: "slots.capacity",
    scale: 100,
    label: "Slot fill rate",
    definition: "Booked ÷ (available + booked) slots, by slot date.",
    unit: "percent",
    goodDirection: "up",
  },

  // Customers
  {
    id: "customers.new",
    kind: "daily",
    label: "New customers",
    definition: "Customers whose first booking that is not cancelled was created that day.",
    unit: "count",
    goodDirection: "up",
    compute: async (from, to, o) =>
      plain(
        await rows(Prisma.sql`
          SELECT ${daySql("f.first")} AS day, COUNT(*)::int AS v
          FROM (
            SELECT a."customerId", MIN(a."createdAt") AS first
            FROM ${APPT} WHERE a.status <> 'CANCELLED' ${real(o)}
            GROUP BY 1
            HAVING MIN(a."createdAt") >= ${utcTs(from)} AND MIN(a."createdAt") < ${utcTs(to)}
          ) f
          GROUP BY 1`),
      ),
  },
  {
    id: "customers.repeatRate",
    kind: "period",
    label: "Repeat rate (90 days)",
    definition:
      "Of the customers whose first completed booking falls in the period, the share with a second completed booking within 90 days of the first.",
    unit: "percent",
    goodDirection: "up",
    period: async (from, to, o) => {
      const [r] = await prisma.$queryRaw<Array<{ total: number; repeat: number }>>`
        WITH firsts AS (
          SELECT a."customerId" AS c, MIN(${raw(COMPLETED_AT)}) AS first
          FROM ${APPT} WHERE a.status = 'COMPLETED' ${real(o)}
          GROUP BY 1
          HAVING MIN(${raw(COMPLETED_AT)}) >= ${utcTs(from)} AND MIN(${raw(COMPLETED_AT)}) < ${utcTs(to)}
        )
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM appointments b JOIN salons sb ON sb.id = b."salonId"
                 WHERE b."customerId" = f.c AND b.status = 'COMPLETED'
                   AND COALESCE(b."completedAt", b."appointmentDate") > f.first
                   AND COALESCE(b."completedAt", b."appointmentDate") <= f.first + interval '90 days'
                   ${o.includeTest ? Prisma.empty : Prisma.sql`AND sb."isTest" = false`}
               ))::int AS repeat
        FROM firsts f`;
      return r && r.total ? (r.repeat / r.total) * 100 : null;
    },
  },
  {
    id: "cohorts",
    kind: "table",
    label: "Monthly cohorts",
    definition:
      "Rows: Dhaka month of a customer's first completed booking. Columns +1…+6: % of that cohort with a completed booking in that later month.",
    unit: "percent",
    goodDirection: "up",
    table: async (from, to, o) => {
      const monthOf = raw(`date_trunc('month', (${COMPLETED_AT} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka')`);
      const found = await prisma.$queryRaw<Array<{ cohort: string; k: number; n: number }>>`
        WITH firsts AS (
          SELECT a."customerId" AS c, MIN(${monthOf}) AS m
          FROM ${APPT} WHERE a.status = 'COMPLETED' ${real(o)} GROUP BY 1
        ),
        act AS (
          SELECT DISTINCT a."customerId" AS c, ${monthOf} AS m
          FROM ${APPT} WHERE a.status = 'COMPLETED' ${real(o)}
        )
        SELECT to_char(f.m, 'YYYY-MM') AS cohort,
               ((EXTRACT(YEAR FROM x.m) - EXTRACT(YEAR FROM f.m)) * 12 + EXTRACT(MONTH FROM x.m) - EXTRACT(MONTH FROM f.m))::int AS k,
               COUNT(*)::int AS n
        FROM firsts f JOIN act x ON x.c = f.c
        WHERE f.m >= date_trunc('month', ${dhakaDay(from)}::date)
          AND f.m <= date_trunc('month', ${dhakaDay(new Date(to.getTime() - 1))}::date)
        GROUP BY 1, 2`;
      const currentMonth = dhakaDay().slice(0, 7);
      const monthsAfter = (cohort: string, k: number) => {
        const [y, m] = cohort.split("-").map(Number);
        const d = new Date(Date.UTC(y, m - 1 + k, 1));
        return d.toISOString().slice(0, 7);
      };
      const cohorts = [...new Set(found.map((r) => r.cohort))].sort();
      return cohorts.map((cohort) => {
        const size = found.find((r) => r.cohort === cohort && r.k === 0)?.n ?? 0;
        const months = [1, 2, 3, 4, 5, 6].map((k) => {
          if (monthsAfter(cohort, k) > currentMonth) return null;
          const n = found.find((r) => r.cohort === cohort && r.k === k)?.n ?? 0;
          return size ? Number(((n / size) * 100).toFixed(1)) : null;
        });
        return { cohort, size, months };
      });
    },
  },
  {
    id: "signups",
    kind: "daily",
    label: "Sign-ups",
    definition: "Users created, by createdAt. Dimension role:<CUSTOMER|SALON_OWNER|…>.",
    unit: "count",
    goodDirection: "up",
    compute: async (from, to, o) => spread(await signups(from, to, o), ["role"]),
  },
  {
    id: "signups.verified",
    kind: "daily",
    hidden: true,
    label: "Sign-ups verified",
    definition: "Users created that day whose email is now verified.",
    unit: "count",
    goodDirection: "up",
    compute: async (from, to, o) => spread(await signups(from, to, o), ["role"], (r) => Number(r.verified)),
  },
  {
    id: "signups.verifiedShare",
    kind: "ratio",
    num: "signups.verified",
    den: "signups",
    scale: 100,
    label: "Verified share",
    definition: "Share of the users created that have verified their email.",
    unit: "percent",
    goodDirection: "up",
  },

  // Salons
  {
    id: "salons.listed",
    kind: "snapshot",
    label: "Salons listed",
    definition: "ACTIVE, not deleted salons. A snapshot: past days hold the count at the end of that day.",
    unit: "count",
    goodDirection: "up",
    compute: async (o) => [
      {
        dimension: "",
        value: await prisma.salon.count({
          where: { status: "ACTIVE", isDeleted: false, ...(o.includeTest ? {} : { isTest: false }) },
        }),
      },
    ],
  },
  {
    id: "salons.active30d",
    kind: "daily",
    filterable: true,
    label: "Active salons (30 days)",
    definition: "Salons with at least one completed booking in the 30 days ending that day.",
    unit: "count",
    goodDirection: "up",
    compute: async (from, to, o) =>
      plain(
        await rows(Prisma.sql`
          SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COUNT(DISTINCT a."salonId")::int AS v
          FROM generate_series(${dhakaDay(from)}::date, ${dhakaDay(new Date(to.getTime() - 1))}::date, interval '1 day') AS d(day)
          JOIN appointments a ON ${dhakaDate(COMPLETED_AT)} BETWEEN d.day::date - 29 AND d.day::date
          JOIN salons s ON s.id = a."salonId"
          JOIN users u ON u.id = a."customerId"
          WHERE a.status = 'COMPLETED'
            AND ${raw(COMPLETED_AT)} >= ${utcTs(new Date(from.getTime() - 31 * DAY_MS))}
            AND ${raw(COMPLETED_AT)} < ${utcTs(to)}
            ${real(o)} ${narrow(o)}
          GROUP BY 1`),
      ),
  },
  {
    id: "salons.timeToApproveHours",
    kind: "daily",
    label: "Median time to approve",
    definition:
      "Median hours from a salon's createdAt to approvedAt, by approval day. approvedAt before 2026-10-09 was backfilled from updatedAt, so older values are approximate.",
    unit: "hours",
    goodDirection: "down",
    compute: async (from, to, o) =>
      plain(
        await rows(Prisma.sql`
          SELECT ${daySql(`s."approvedAt"`)} AS day, percentile_cont(0.5) WITHIN GROUP (ORDER BY ${APPROVE_HOURS})::float AS v
          FROM salons s WHERE s."approvedAt" IS NOT NULL AND ${between(`s."approvedAt"`, from, to)} ${realSalon(o)}
          GROUP BY 1`),
      ),
    period: (from, to, o) =>
      one(Prisma.sql`
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ${APPROVE_HOURS})::float AS v
        FROM salons s WHERE s."approvedAt" IS NOT NULL AND ${between(`s."approvedAt"`, from, to)} ${realSalon(o)}`),
  },

  // Balances (snapshots, from settlement.earnings)
  {
    id: "wallet.floatMinor",
    kind: "snapshot",
    label: "Wallet float",
    definition: "Sum of customer wallet balances (walletFloatMinor). A liability, not revenue.",
    unit: "minor",
    goodDirection: "up",
    compute: async (o) => [{ dimension: "", value: (await balances(o)).walletFloatMinor }],
  },
  {
    id: "deposits.heldMinor",
    kind: "snapshot",
    label: "Deposits held",
    definition: "Deposits currently HELD on bookings (depositsHeldMinor).",
    unit: "minor",
    goodDirection: "up",
    compute: async (o) => [{ dimension: "", value: (await balances(o)).depositsHeldMinor }],
  },
  {
    id: "payable.minor",
    kind: "snapshot",
    label: "Owed to salons",
    definition: "SALON_PAYABLE ledger balance (salonPayableMinor).",
    unit: "minor",
    goodDirection: "down",
    compute: async (o) => [{ dimension: "", value: (await balances(o)).salonPayableMinor }],
  },

  // Top-ups
  {
    id: "topups.succeeded",
    kind: "daily",
    hidden: true,
    label: "Top-ups succeeded",
    definition: "WALLET_TOPUP payment intents with status SUCCESS, by createdAt.",
    unit: "count",
    goodDirection: "up",
    compute: async (from, to, o) => plain(await topups(from, to, o)),
  },
  {
    id: "topups.finished",
    kind: "daily",
    hidden: true,
    label: "Top-ups finished",
    definition: "WALLET_TOPUP payment intents that reached SUCCESS, FAILED, CANCELLED or EXPIRED, by createdAt.",
    unit: "count",
    goodDirection: "up",
    compute: async (from, to, o) => spread(await topups(from, to, o), [], (r) => Number(r.finished)),
  },
  {
    id: "topups.successRate",
    kind: "ratio",
    num: "topups.succeeded",
    den: "topups.finished",
    scale: 100,
    label: "Top-up success rate",
    definition: "Successful ÷ finished top-up attempts (abandoned INITIATED ones are not counted).",
    unit: "percent",
    goodDirection: "up",
  },
  {
    id: "topups.volumeMinor",
    kind: "daily",
    label: "Top-up volume",
    definition: "Sum of TOPUP wallet transactions by createdAt (topupVolumeMinor).",
    unit: "minor",
    goodDirection: "up",
    compute: money((m) => m.topupVolumeMinor),
  },
  {
    id: "refunds.count",
    kind: "daily",
    hidden: true,
    label: "Top-ups reversed",
    definition: "TOPUP_REVERSAL wallet transactions (refunds and charge-backs of top-ups), by createdAt.",
    unit: "count",
    goodDirection: "down",
    compute: async (from, to, o) =>
      plain(
        await rows(Prisma.sql`
          SELECT ${daySql(`t."createdAt"`)} AS day, COUNT(*)::int AS v
          FROM wallet_transactions t JOIN wallets w ON w.id = t."walletId" JOIN users u ON u.id = w."userId"
          WHERE t.type = 'TOPUP_REVERSAL' AND ${between(`t."createdAt"`, from, to)} ${realUser(o)}
          GROUP BY 1`),
      ),
  },
  {
    id: "refunds.rate",
    kind: "ratio",
    num: "refunds.count",
    den: "topups.succeeded",
    scale: 100,
    label: "Top-up refund rate",
    definition: "Reversed top-ups ÷ successful top-ups.",
    unit: "percent",
    goodDirection: "down",
  },

  // Search
  {
    id: "search.count",
    kind: "daily",
    testless: true,
    volatile: true,
    label: "Searches",
    definition: "Searches with a term, from search_query_daily. Dimension surface:<LIST|AI>. Only the first results page of GET /salons counts.",
    unit: "count",
    goodDirection: "up",
    compute: async (from, to) => spread(await searches(from, to), ["surface"]),
  },
  {
    id: "search.zero",
    kind: "daily",
    testless: true,
    volatile: true,
    hidden: true,
    label: "Searches with no results",
    definition: "Searches that returned nothing. Dimension surface:.",
    unit: "count",
    goodDirection: "down",
    compute: async (from, to) => spread(await searches(from, to), ["surface"], (r) => Number(r.zero)),
  },
  {
    id: "search.zeroShare",
    kind: "ratio",
    num: "search.zero",
    den: "search.count",
    scale: 100,
    label: "Zero-result share",
    definition: "Share of searches that found nothing.",
    unit: "percent",
    goodDirection: "down",
  },

  // AI search (captured live in POST /ai/search)
  {
    id: "ai.searches",
    kind: "captured",
    label: "AI searches",
    definition: "Calls to POST /ai/search that returned.",
    unit: "count",
    goodDirection: "up",
  },
  {
    id: "ai.tier",
    kind: "captured",
    label: "AI result tier",
    definition: "AI searches by the best tier among their results. Dimension tier:<best|partial|alternative|none>.",
    unit: "count",
    goodDirection: "up",
  },
  {
    id: "ai.llm",
    kind: "captured",
    hidden: true,
    label: "AI searches using the model",
    definition: "AI searches where Gemini read the query or wrote the reply (a cached reply does not count).",
    unit: "count",
    goodDirection: "down",
  },
  {
    id: "ai.latency",
    kind: "captured",
    hidden: true,
    label: "AI search latency histogram",
    definition: "AI searches by total time, dimension le:<ms> (bucket upper edges).",
    unit: "count",
    goodDirection: "down",
  },
  {
    id: "ai.latencyP50",
    kind: "quantile",
    hist: "ai.latency",
    q: 0.5,
    label: "AI search P50 (ms)",
    definition: "Median AI search time in milliseconds, read from the latency histogram (bucket upper edge).",
    unit: "count",
    goodDirection: "down",
  },
  {
    id: "ai.latencyP95",
    kind: "quantile",
    hist: "ai.latency",
    q: 0.95,
    label: "AI search P95 (ms)",
    definition: "95th percentile AI search time in milliseconds, from the latency histogram.",
    unit: "count",
    goodDirection: "down",
  },
  {
    id: "ai.llmShare",
    kind: "ratio",
    num: "ai.llm",
    den: "ai.searches",
    scale: 100,
    label: "AI searches using the model",
    definition: "Share of AI searches that called Gemini.",
    unit: "percent",
    goodDirection: "down",
  },

  // Booking assistant
  {
    id: "assistant.conversations",
    kind: "daily",
    volatile: true,
    label: "Assistant conversations",
    definition: "Assistant conversations started, by createdAt. Rolled up before conversations expire.",
    unit: "count",
    goodDirection: "up",
    compute: async (from, to, o) =>
      plain(
        await rows(Prisma.sql`
          SELECT ${daySql(`c."createdAt"`)} AS day, COUNT(*)::int AS v
          FROM assistant_conversations c LEFT JOIN users u ON u.id = c."userId"
          WHERE ${between(`c."createdAt"`, from, to)} ${realUser(o)}
          GROUP BY 1`),
      ),
  },
  {
    id: "assistant.reachedSummary",
    kind: "daily",
    volatile: true,
    label: "Assistant reached the summary",
    definition: "Conversations started that day that showed a booking summary.",
    unit: "count",
    goodDirection: "up",
    compute: async (from, to, o) =>
      plain(
        await rows(Prisma.sql`
          SELECT ${daySql(`c."createdAt"`)} AS day, COUNT(DISTINCT c.id)::int AS v
          FROM assistant_conversations c
          LEFT JOIN users u ON u.id = c."userId"
          JOIN assistant_messages m ON m."conversationId" = c.id AND m.role = 'ASSISTANT'
            AND m.blocks @> '[{"type":"booking_summary"}]'::jsonb
          WHERE ${between(`c."createdAt"`, from, to)} ${realUser(o)}
          GROUP BY 1`),
      ),
  },
  {
    id: "assistant.bookings",
    kind: "daily",
    label: "Assistant bookings",
    definition: "Bookings with bookedVia ASSISTANT, by createdAt (from appointments, so deleted chats do not remove them).",
    unit: "count",
    goodDirection: "up",
    compute: async (from, to, o) =>
      spread(
        (await bookingsCreated(from, to, o)).filter((r) => r.channel === "ASSISTANT"),
        [],
      ),
  },
  {
    id: "assistant.conversion",
    kind: "ratio",
    num: "assistant.bookings",
    den: "assistant.conversations",
    scale: 100,
    label: "Assistant conversion",
    definition: "Assistant bookings ÷ assistant conversations, by day.",
    unit: "percent",
    goodDirection: "up",
  },

  // Hairstyle try-on
  {
    id: "tryon.uploads",
    kind: "daily",
    testless: true,
    volatile: true,
    label: "Try-on uploads",
    definition: "Try-on photo uploads started, by createdAt. Rolled up before rows are purged (30 days).",
    unit: "count",
    goodDirection: "up",
    compute: async (from, to) =>
      plain(
        await rows(Prisma.sql`
          SELECT ${daySql(`h."createdAt"`)} AS day, COUNT(*)::int AS v
          FROM hair_tryon_uploads h WHERE ${between(`h."createdAt"`, from, to)} GROUP BY 1`),
      ),
  },
  {
    id: "tryon.done",
    kind: "daily",
    testless: true,
    volatile: true,
    label: "Try-ons generated",
    definition: "Try-on jobs that finished DONE, by createdAt.",
    unit: "count",
    goodDirection: "up",
    compute: async (from, to) => spread((await tryonJobs(from, to)).filter((r) => r.status === "DONE")),
  },
  {
    id: "tryon.failed",
    kind: "daily",
    testless: true,
    volatile: true,
    label: "Try-ons failed",
    definition: "Try-on jobs that FAILED, by createdAt. Dimension code:<errorCode>.",
    unit: "count",
    goodDirection: "down",
    compute: async (from, to) => spread((await tryonJobs(from, to)).filter((r) => r.status === "FAILED"), ["code"]),
  },
  {
    id: "tryon.latency",
    kind: "daily",
    testless: true,
    volatile: true,
    hidden: true,
    label: "Try-on latency histogram",
    definition: "DONE try-on jobs by latencyMs, dimension le:<ms>.",
    unit: "count",
    goodDirection: "down",
    compute: async (from, to) => {
      const done = (await tryonJobs(from, to)).filter((r) => r.status === "DONE" && r.ms !== null);
      return spread(done.map((r) => ({ ...r, le: latencyBucket(Number(r.ms)).slice(3) })), ["le"]);
    },
  },
  {
    id: "tryon.latencyP50",
    kind: "quantile",
    hist: "tryon.latency",
    q: 0.5,
    label: "Try-on P50 (ms)",
    definition: "Median try-on generation time in milliseconds, from the latency histogram.",
    unit: "count",
    goodDirection: "down",
  },

  // Visitors and the funnel
  {
    id: "visitors.unique",
    kind: "daily",
    testless: true,
    volatile: true,
    label: "Unique visitors",
    definition:
      "Distinct visitors per Dhaka day (a daily-salted hash, so the same person on two days counts twice; a range is the sum of its days).",
    unit: "count",
    goodDirection: "up",
    compute: async (from, to) =>
      plain(
        await rows(Prisma.sql`
          SELECT day::text AS day, COUNT(*)::int AS v FROM visitor_daily WHERE ${dayRange("day", from, to)} GROUP BY 1`),
      ),
  },
  ...EVENT_NAMES.map(funnelEvent),
  {
    id: "events.rejected",
    kind: "captured",
    label: "Events rejected",
    definition: "Events sent to POST /events that were not on the allow-list (or had a value off it).",
    unit: "count",
    goodDirection: "down",
  },

  // Support
  {
    id: "support.opened",
    kind: "daily",
    label: "Tickets opened",
    definition: "Support tickets created, by createdAt.",
    unit: "count",
    goodDirection: "down",
    compute: async (from, to, o) => plain(await tickets(from, to, o)),
  },
  {
    id: "support.firstResponseMedianH",
    kind: "daily",
    label: "Median first response",
    definition: "Median hours from a ticket's creation to the first reply that was emailed, by created day.",
    unit: "hours",
    goodDirection: "down",
    ...ticketHours("firstResponseAt"),
  },
  {
    id: "support.resolveMedianH",
    kind: "daily",
    label: "Median time to resolve",
    definition: "Median hours from a ticket's creation to resolvedAt, by created day.",
    unit: "hours",
    goodDirection: "down",
    ...ticketHours("resolvedAt"),
  },

  // Reviews
  {
    id: "reviews.count",
    kind: "daily",
    label: "Reviews",
    definition: "Reviews written, by createdAt, any status.",
    unit: "count",
    goodDirection: "up",
    compute: async (from, to, o) => plain(await reviews(from, to, o)),
  },
  {
    id: "reviews.ratingSum",
    kind: "daily",
    hidden: true,
    label: "Review stars",
    definition: "Sum of review ratings, by createdAt.",
    unit: "count",
    goodDirection: "up",
    compute: async (from, to, o) => spread(await reviews(from, to, o), [], (r) => Number(r.stars)),
  },
  {
    id: "reviews.hidden",
    kind: "daily",
    hidden: true,
    label: "Reviews hidden",
    definition: "Reviews written that day that are now HIDDEN.",
    unit: "count",
    goodDirection: "down",
    compute: async (from, to, o) => spread(await reviews(from, to, o), [], (r) => Number(r.hidden)),
  },
  {
    id: "reviews.avgRating",
    kind: "ratio",
    num: "reviews.ratingSum",
    den: "reviews.count",
    scale: 1,
    label: "Average rating",
    definition: "Mean star rating of the reviews written (hidden ones included).",
    unit: "count",
    goodDirection: "up",
  },
  {
    id: "reviews.hiddenShare",
    kind: "ratio",
    num: "reviews.hidden",
    den: "reviews.count",
    scale: 100,
    label: "Hidden share",
    definition: "Share of the reviews written that were hidden by moderation.",
    unit: "percent",
    goodDirection: "down",
  },

  // Report tables
  {
    id: "geo.areas",
    kind: "table",
    label: "By area",
    definition:
      "Per salon area: ACTIVE salons listed now, bookings created and completed in the period, and completed GMV (from settlement.earnings).",
    unit: "count",
    goodDirection: "up",
    table: async (from, to, o) => {
      const [money, created, listed] = await Promise.all([
        SettlementEarnings.getMoneyByArea({ from, to, ...o }),
        rows(Prisma.sql`
          SELECT s.area AS day, COUNT(*)::int AS v
          FROM ${APPT} WHERE ${between(`a."createdAt"`, from, to)} ${real(o)} ${narrow(o)}
          GROUP BY 1`),
        rows(Prisma.sql`
          SELECT s.area AS day, COUNT(*)::int AS v
          FROM salons s WHERE s.status = 'ACTIVE' AND s."isDeleted" = false ${realSalon(o)}
            ${o.area ? Prisma.sql`AND lower(trim(s.area)) = ${o.area.trim().toLowerCase()}` : Prisma.empty}
          GROUP BY 1`),
      ]);
      const areas = new Map<string, { area: string; district: string; listed: number; created: number; completed: number; gmvMinor: number }>();
      const get = (area: string) => {
        let a = areas.get(area);
        if (!a) {
          a = { area, district: "", listed: 0, created: 0, completed: 0, gmvMinor: 0 };
          areas.set(area, a);
        }
        return a;
      };
      for (const r of listed) get(r.day).listed = Number(r.v);
      for (const r of created) get(r.day).created = Number(r.v);
      for (const m of money) Object.assign(get(m.area), { district: m.district, completed: m.completed, gmvMinor: m.gmvMinor });
      return [...areas.values()].sort((x, y) => y.gmvMinor - x.gmvMinor || y.created - x.created);
    },
  },
  {
    id: "search.terms",
    kind: "table",
    label: "Search terms",
    definition:
      "Most searched normalised terms per surface, and the most frequent ones that found nothing. Terms are kept 90 days, and emails or 7+ digit numbers are never stored.",
    unit: "count",
    goodDirection: "up",
    table: async (from, to) => {
      const found = await prisma.$queryRaw<Array<{ term: string; surface: string; count: number; zero: number }>>`
        SELECT term, surface, SUM(count)::int AS count, SUM("zeroResults")::int AS zero
        FROM search_query_daily WHERE ${dayRange("day", from, to)}
        GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 500`;
      return {
        top: found.slice(0, 50),
        zeroResults: found.filter((r) => r.zero > 0).sort((x, y) => y.zero - x.zero).slice(0, 50),
      };
    },
  },
];

export const METRIC_BY_ID = new Map(METRICS.map((m) => [m.id, m]));

export const getMetric = (id: string) => {
  const m = METRIC_BY_ID.get(id);
  if (!m) throw new Error(`Unknown metric ${id}`);
  return m;
};

/** Whether the metric's stored rows carry a `*` (test-included) variant. */
export const hasTestVariant = (m: Metric) => m.kind === "snapshot" || (m.kind === "daily" && !m.testless);
