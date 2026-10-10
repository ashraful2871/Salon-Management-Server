import prisma from "../../../shared/prisma";
import { SettlementEarnings } from "../../Settlement/settlement.earnings";
import { AssistantStats } from "../../Assistant/assistant.stats";
import { addDays, dateOnly, dayStart, daysBetween, dhakaDay } from "../../Analytics/analytics.days";
import {
  getMetric,
  hasTestVariant,
  METRICS,
  type Metric,
  type MetricOpts,
  type TableMetric,
} from "../../Analytics/analytics.metrics";

/**
 * `/admin/analytics/:report`. Each report is a list of metric ids from the
 * dictionary plus a few tables. Past days are read from `metric_daily`;
 * today, snapshots for today and anything narrowed by `area`/`channel` are
 * computed live from the same definitions.
 */

export const REPORTS = ["overview", "bookings", "customers", "salons", "geo", "funnel", "search", "assistant", "tryon"] as const;
export type ReportName = (typeof REPORTS)[number];

export type ReportQuery = {
  from: string;
  to: string;
  compare: "prev" | "none";
  includeTest: boolean;
  area?: string;
  channel?: string;
};

/** metric → dimension → day → value */
type Store = Map<string, Map<string, Map<string, number>>>;

const put = (store: Store, metric: string, dimension: string, day: string, value: number) => {
  let dims = store.get(metric);
  if (!dims) store.set(metric, (dims = new Map()));
  let days = dims.get(dimension);
  if (!days) dims.set(dimension, (days = new Map()));
  days.set(day, (days.get(day) ?? 0) + value);
};

/** The stored (base) metrics a metric is read from. */
const baseIds = (m: Metric): string[] => {
  if (m.kind === "ratio") return [...baseIds(getMetric(m.num)), ...baseIds(getMetric(m.den))];
  if (m.kind === "quantile") return [m.hist];
  if (m.kind === "daily" || m.kind === "snapshot" || m.kind === "captured") return [m.id];
  return [];
};

const optsOf = (q: ReportQuery): MetricOpts => ({ includeTest: q.includeTest, area: q.area, channel: q.channel });
const isFiltered = (q: ReportQuery) => Boolean(q.area || q.channel);

const load = async (ids: string[], from: string, to: string, q: ReportQuery): Promise<Store> => {
  const store: Store = new Map();
  const today = dhakaDay();
  const opts = optsOf(q);
  const base = [...new Set(ids.flatMap((id) => baseIds(getMetric(id))))].map(getMetric);
  const live = (m: Metric) => m.kind === "daily" && isFiltered(q) && m.filterable;

  const stored = base.filter((m) => !live(m)).map((m) => m.id);
  if (stored.length) {
    const found = await prisma.metricDaily.findMany({
      where: { metric: { in: stored }, day: { gte: dateOnly(from), lte: dateOnly(to) } },
      select: { day: true, metric: true, dimension: true, value: true },
    });
    for (const r of found) {
      const m = getMetric(r.metric);
      const day = r.day.toISOString().slice(0, 10);
      // Today is live for everything but the live counters.
      if (day >= today && m.kind !== "captured") continue;
      let dim = r.dimension;
      if (hasTestVariant(m)) {
        const isTestVariant = dim.startsWith("*");
        if (isTestVariant !== q.includeTest) continue;
        if (isTestVariant) dim = dim.slice(1);
      }
      put(store, m.id, dim, day, r.value);
    }
  }

  const work: Promise<void>[] = [];
  for (const m of base) {
    if (m.kind === "daily") {
      const range = live(m) ? [from, to] : to >= today ? [today > from ? today : from, today] : null;
      if (!range) continue;
      work.push(
        m.compute(dayStart(range[0]), dayStart(addDays(range[1], 1)), opts).then((found) => {
          for (const r of found) put(store, m.id, r.dimension, r.day, r.value);
        }),
      );
    } else if (m.kind === "snapshot" && to >= today) {
      work.push(
        m.compute(opts).then((found) => {
          for (const r of found) put(store, m.id, r.dimension, today, r.value);
        }),
      );
    }
  }
  await Promise.all(work);
  return store;
};

const cell = (store: Store, id: string, dim: string, day: string) => store.get(id)?.get(dim)?.get(day);
const total = (store: Store, id: string, dim: string) => {
  let sum = 0;
  for (const v of store.get(id)?.get(dim)?.values() ?? []) sum += v;
  return sum;
};
/** A ratio's denominator by the same dimension when it has one, else its total. */
const denDim = (store: Store, den: string, dim: string) => (store.get(den)?.has(dim) ? dim : "");

const quantile = (hist: Map<string, number>, q: number): number | null => {
  const buckets = [...hist]
    .filter(([dim, n]) => dim.startsWith("le:") && n > 0)
    .map(([dim, n]) => ({ edge: dim === "le:inf" ? Infinity : Number(dim.slice(3)), n }))
    .sort((a, b) => a.edge - b.edge);
  const count = buckets.reduce((s, b) => s + b.n, 0);
  if (!count) return null;
  let seen = 0;
  for (const b of buckets) {
    seen += b.n;
    if (seen >= q * count) return Number.isFinite(b.edge) ? b.edge : (buckets[buckets.length - 2]?.edge ?? null);
  }
  return null;
};

const histFor = (store: Store, id: string, day?: string) => {
  const out = new Map<string, number>();
  for (const [dim, days] of store.get(id) ?? []) {
    out.set(dim, day ? (days.get(day) ?? 0) : [...days.values()].reduce((s, v) => s + v, 0));
  }
  return out;
};

const round = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Number(v.toFixed(2)));

const seriesOf = (store: Store, m: Metric, days: string[], dim = "") => {
  if (m.kind === "period" || m.kind === "table") return undefined;
  return days.map((day) => {
    let value: number | null;
    if (m.kind === "ratio") {
      const den = cell(store, m.den, denDim(store, m.den, dim), day) ?? 0;
      value = den ? ((cell(store, m.num, dim, day) ?? 0) / den) * m.scale : null;
    } else if (m.kind === "quantile") {
      value = quantile(histFor(store, m.hist, day), m.q);
    } else if (m.kind === "snapshot") {
      value = cell(store, m.id, dim, day) ?? null;
    } else {
      value = cell(store, m.id, dim, day) ?? 0;
    }
    return { day, value: round(value) };
  });
};

const kpiOf = async (store: Store, m: Metric, from: string, to: string, q: ReportQuery, dim = "") => {
  const range = [dayStart(from), dayStart(addDays(to, 1))] as const;
  switch (m.kind) {
    case "period":
      return m.period(range[0], range[1], optsOf(q));
    case "daily":
      return m.period ? m.period(range[0], range[1], optsOf(q)) : total(store, m.id, dim);
    case "captured":
      return total(store, m.id, dim);
    case "snapshot": {
      const days = [...(store.get(m.id)?.get(dim)?.keys() ?? [])].sort();
      return days.length ? (cell(store, m.id, dim, days[days.length - 1]) ?? null) : null;
    }
    case "ratio": {
      const den = total(store, m.den, denDim(store, m.den, dim));
      return den ? (total(store, m.num, dim) / den) * m.scale : null;
    }
    case "quantile":
      return quantile(histFor(store, m.hist), m.q);
    default:
      return null;
  }
};

/** Per-dimension totals of a metric, e.g. bookings.created by channel. */
const breakdown = (store: Store, id: string, key: string) =>
  [...(store.get(id) ?? [])]
    .filter(([dim]) => dim.startsWith(`${key}:`))
    .map(([dim, days]) => ({ key: dim.slice(key.length + 1), value: [...days.values()].reduce((s, v) => s + v, 0) }))
    .sort((a, b) => b.value - a.value);

const table = (id: string, from: string, to: string, q: ReportQuery) =>
  (getMetric(id) as TableMetric).table(dayStart(from), dayStart(addDays(to, 1)), optsOf(q));

type Ctx = { store: Store; from: string; to: string; q: ReportQuery };

type ReportDef = {
  kpis: string[];
  series: string[];
  /** Extra ids loaded for the tables (dimension breakdowns). */
  extra?: string[];
  tables?: (ctx: Ctx) => Promise<Record<string, unknown>> | Record<string, unknown>;
};

const FUNNEL_STEPS = ["funnel.page_view", "funnel.salon_list_viewed", "funnel.salon_viewed", "funnel.booking_started", "funnel.slot_selected"];

const DEFS: Record<ReportName, ReportDef> = {
  overview: {
    kpis: [
      "gmv.completedMinor",
      "commission.minor",
      "takeRate",
      "bookings.created",
      "bookings.completed",
      "cancel.rate",
      "customers.new",
      "visitors.unique",
      "salons.listed",
      "wallet.floatMinor",
      "deposits.heldMinor",
      "payable.minor",
      "topups.volumeMinor",
      "topups.successRate",
      "refunds.rate",
      "support.opened",
      "support.firstResponseMedianH",
      "support.resolveMedianH",
    ],
    series: ["gmv.completedMinor", "commission.minor", "bookings.created", "bookings.completed", "visitors.unique"],
  },
  bookings: {
    kpis: [
      "bookings.created",
      "bookings.completed",
      "ticket.avgMinor",
      "cancel.rate",
      "noshow.rate",
      "leadTime.medianDays",
      "slots.fillRate",
    ],
    series: ["bookings.created", "bookings.completed", "cancel.rate", "noshow.rate", "slots.fillRate"],
    extra: ["bookings.cancelled"],
    tables: ({ store }) => ({
      byChannel: breakdown(store, "bookings.created", "channel"),
      bySource: breakdown(store, "bookings.created", "source"),
      cancelledBy: breakdown(store, "bookings.cancelled", "by"),
    }),
  },
  customers: {
    kpis: ["customers.new", "customers.repeatRate", "signups", "signups.verifiedShare"],
    series: ["customers.new", "signups"],
    tables: async ({ store, from, to, q }) => ({
      cohorts: await table("cohorts", from, to, q),
      signupsByRole: breakdown(store, "signups", "role"),
    }),
  },
  salons: {
    kpis: [
      "salons.listed",
      "salons.active30d",
      "salons.timeToApproveHours",
      "slots.fillRate",
      "reviews.count",
      "reviews.avgRating",
      "reviews.hiddenShare",
    ],
    series: ["salons.listed", "salons.active30d", "reviews.count"],
    tables: async ({ from, to, q }) => ({
      topSalons: await SettlementEarnings.getMoneyBySalon({
        from: dayStart(from),
        to: dayStart(addDays(to, 1)),
        ...optsOf(q),
      }),
    }),
  },
  geo: {
    kpis: ["salons.listed", "bookings.created", "gmv.completedMinor"],
    series: [],
    tables: async ({ from, to, q }) => ({ areas: await table("geo.areas", from, to, q) }),
  },
  funnel: {
    kpis: [...FUNNEL_STEPS, "bookings.created", "visitors.unique", "funnel.search_submitted", "funnel.signup_started"],
    series: ["visitors.unique", "funnel.page_view", "funnel.salon_viewed", "funnel.booking_started"],
    extra: ["funnel.assistant_opened", "funnel.hair_tryon_opened"],
    tables: ({ store }) => {
      const steps = [...FUNNEL_STEPS.map((id) => ({ id, value: total(store, id, "") })), {
        id: "bookings.created",
        value: total(store, "bookings.created", "channel:WEB"),
      }];
      return {
        steps: steps.map((s, i) => ({
          ...s,
          label: getMetric(s.id).label,
          fromPrevious: i && steps[i - 1].value ? round((s.value / steps[i - 1].value) * 100) : null,
        })),
        pages: breakdown(store, "funnel.page_view", "page"),
        referrers: breakdown(store, "funnel.page_view", "ref"),
        listModes: breakdown(store, "funnel.salon_list_viewed", "mode"),
        searchSources: breakdown(store, "funnel.search_submitted", "source"),
        signupMethods: breakdown(store, "funnel.signup_started", "method"),
        assistantEntries: breakdown(store, "funnel.assistant_opened", "entry"),
      };
    },
  },
  search: {
    kpis: ["search.count", "search.zeroShare", "ai.searches"],
    series: ["search.count", "search.zeroShare"],
    tables: async ({ store, from, to, q }) => ({
      surfaces: breakdown(store, "search.count", "surface"),
      terms: await table("search.terms", from, to, q),
    }),
  },
  assistant: {
    kpis: [
      "assistant.conversations",
      "assistant.reachedSummary",
      "assistant.bookings",
      "assistant.conversion",
      "ai.searches",
      "ai.latencyP50",
      "ai.latencyP95",
      "ai.llmShare",
    ],
    series: ["assistant.conversations", "assistant.bookings", "ai.searches", "ai.latencyP50"],
    extra: ["ai.tier"],
    tables: async ({ store }) => ({
      aiTiers: breakdown(store, "ai.tier", "tier"),
      // The assistant's own launch view: last 14 days, outcomes and drop-off.
      assistantLive: await AssistantStats.getStats(),
    }),
  },
  tryon: {
    kpis: ["tryon.uploads", "tryon.done", "tryon.failed", "tryon.latencyP50"],
    series: ["tryon.uploads", "tryon.done", "tryon.failed"],
    tables: ({ store }) => ({ failures: breakdown(store, "tryon.failed", "code") }),
  },
};

const MAX_DAYS = 400;

const previousRange = (from: string, to: string) => {
  const length = daysBetween(from, to).length;
  return { from: addDays(from, -length), to: addDays(from, -1) };
};

export const getReport = async (name: ReportName, q: ReportQuery) => {
  const def = DEFS[name];
  const days = daysBetween(q.from, q.to).slice(0, MAX_DAYS);
  const ids = [...new Set([...def.kpis, ...def.series, ...(def.extra ?? [])])];
  const prev = q.compare === "prev" ? previousRange(q.from, q.to) : null;

  const [store, prevStore] = await Promise.all([
    load(ids, q.from, q.to, q),
    prev ? load(def.kpis, prev.from, prev.to, q) : Promise.resolve(null),
  ]);

  const kpis = await Promise.all(
    def.kpis.map(async (id) => {
      const m = getMetric(id);
      const value = round(await kpiOf(store, m, q.from, q.to, q));
      const previous = prev && prevStore ? round(await kpiOf(prevStore, m, prev.from, prev.to, q)) : undefined;
      return {
        id,
        label: m.label,
        value,
        ...(previous !== undefined && { previous }),
        unit: m.unit,
        goodDirection: m.goodDirection,
        ...(isFiltered(q) && !(m.kind === "daily" && m.filterable) && { filtersIgnored: true }),
      };
    }),
  );

  const series: Record<string, Array<{ day: string; value: number | null }>> = {};
  for (const id of def.series) {
    const s = seriesOf(store, getMetric(id), days);
    if (s) series[id] = s;
  }

  const tables = def.tables ? await def.tables({ store, from: q.from, to: q.to, q }) : {};

  return {
    report: name,
    range: { from: q.from, to: q.to, timeZone: "Asia/Dhaka", ...(prev && { previous: prev }) },
    filters: { includeTest: q.includeTest, area: q.area ?? null, channel: q.channel ?? null },
    kpis,
    series,
    tables,
  };
};

/** The dictionary for tooltips and the "how is this counted" panel. */
export const listMetrics = () =>
  METRICS.filter((m) => !m.hidden).map(({ id, label, definition, unit, goodDirection, kind }) => ({
    id,
    label,
    definition,
    unit,
    goodDirection,
    kind,
  }));

export const AdminAnalyticsService = { getReport, listMetrics };
