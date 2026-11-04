import { HomeAudience, HomeCategory, Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { getSetting, getSettingSync } from "../../utils/settings";
import { incrementMetrics, recordSearchTerm } from "../Analytics/analytics.capture";
import { addDays, dhakaDay, isDay } from "../Analytics/analytics.days";
import { SALON_GEOG } from "../Salon/salon.geo";
import { BD_BOUNDS } from "../Salon/salon.validation";
import {
  availableFor,
  computeSlots,
  dayLabel,
  eligibleExpertWhere,
  loadCart,
  loadExpertDays,
  loadSlotSettings,
  slotLabel,
  slotPeriod,
  windowDays,
} from "./home.availability";
import { isBranchBookable, loadHomeFlags, loadPolicyInForce } from "./home.owner";
import { listExpertReviews } from "./home.reviews";
import {
  matchExpert,
  matchFields,
  offeringFields,
  parseQuery,
  personFields,
  preferExact,
  type HomeQuery,
} from "./home.search";

/**
 * What guests and customers see before booking: the catalog and experts near
 * a point, an expert's profile, and the slot / day lists. Every branch goes
 * through `isBranchBookable`; a test salon is shown only to test customers.
 */

type Query = Record<string, unknown>;
export type Viewer = { userId?: string } | undefined;

const PAGE_SIZE = 20;
const SOONEST_DAYS = 2;
const BRANCH_CAP = 500;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : Array.isArray(v) ? String(v[0] ?? "").trim() : "");

const audienceOf = (q: Query): HomeAudience => {
  const v = str(q.audience).toUpperCase();
  if (!v || v === "LADIES") return HomeAudience.LADIES;
  if (v === "GENTS") return HomeAudience.GENTS;
  throw new ApiError(StatusCodes.BAD_REQUEST, "audience must be LADIES or GENTS");
};

type Point = { lat: number; lng: number };

const invalidLocation = () =>
  ApiError.withCode(StatusCodes.BAD_REQUEST, "Pick a location inside Bangladesh.", "INVALID_LOCATION");

function pointOf(q: Query, required: true): Point;
function pointOf(q: Query, required: false): Point | null;
function pointOf(q: Query, required: boolean): Point | null {
  const rawLat = str(q.lat);
  const rawLng = str(q.lng);
  if (!rawLat && !rawLng && !required) return null;
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  if (
    !rawLat ||
    !rawLng ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < BD_BOUNDS.minLat ||
    lat > BD_BOUNDS.maxLat ||
    lng < BD_BOUNDS.minLng ||
    lng > BD_BOUNDS.maxLng
  ) {
    throw invalidLocation();
  }
  return { lat, lng };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `offeringIds=a,b` or repeated `offeringIds=a&offeringIds=b`. */
const offeringIdsOf = (q: Query) => {
  const raw = Array.isArray(q.offeringIds) ? q.offeringIds.map(String) : str(q.offeringIds).split(",");
  const ids = raw.map((s) => s.trim()).filter(Boolean);
  if (ids.length < 1 || ids.length > 10 || !ids.every((id) => UUID.test(id))) {
    throw ApiError.withCode(StatusCodes.BAD_REQUEST, "Pick between 1 and 10 services.", "INVALID_CART");
  }
  return ids;
};

const idOf = (v: unknown, name: string) => {
  const id = str(v);
  if (!UUID.test(id)) throw new ApiError(StatusCodes.BAD_REQUEST, `${name} must be a valid id`);
  return id;
};

const pageOf = (q: Query) => {
  const n = Number(str(q.page) || 1);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : 1;
};

const viewerIsTest = async (viewer: Viewer) =>
  viewer?.userId
    ? ((await prisma.user.findUnique({ where: { id: viewer.userId }, select: { isTest: true } }))?.isTest ?? false)
    : false;

const unavailable = () =>
  ApiError.withCode(StatusCodes.NOT_FOUND, "Home service isn't available here right now.", "HOME_SERVICE_UNAVAILABLE");

const km = (m: number) => Math.round(m / 100) / 10;

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

const BRANCH_SELECT = {
  salonId: true,
  isOn: true,
  ladiesEnabled: true,
  gentsEnabled: true,
  status: true,
  pausedUntil: true,
  radiusKm: true,
  travelFeeMinor: true,
  minOrderMinor: true,
  travelBufferMin: true,
  salon: {
    select: {
      id: true,
      name: true,
      area: true,
      city: true,
      images: true,
      rating: true,
      totalReviews: true,
      status: true,
      isDeleted: true,
      isTest: true,
      bookingPause: true,
    },
  },
} satisfies Prisma.HomeServiceProfileSelect;

type Branch = Prisma.HomeServiceProfileGetPayload<{ select: typeof BRANCH_SELECT }>;

const effectiveRadiusKm = (branch: Pick<Branch, "radiusKm">, maxRadiusKm: number) => Math.min(branch.radiusKm, maxRadiusKm);

/** Branches whose radius covers `point` and whose `audience` side is bookable, nearest first. */
const servingBranches = async (point: Point, audience: HomeAudience, includeTest: boolean) => {
  const [flags, maxRadiusKm] = await Promise.all([loadHomeFlags(), getSetting("homeService.maxRadiusKm")]);
  if (!flags.enabled) return [];
  const origin = Prisma.sql`ST_SetSRID(ST_MakePoint(${point.lng}::float8, ${point.lat}::float8), 4326)::geography`;
  // The constant-radius ST_DWithin lets the salons_geog_gist index do the work.
  const rows = await prisma.$queryRaw<{ id: string; distance_m: number }[]>`
    SELECT s.id, ST_Distance(${SALON_GEOG}, ${origin})::float8 AS distance_m
    FROM salons s
    JOIN home_service_profiles p ON p."salonId" = s.id
    WHERE s."isDeleted" = false
      AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
      AND p."isOn" = true
      AND (${includeTest} OR s."isTest" = false)
      AND ST_DWithin(${SALON_GEOG}, ${origin}, ${maxRadiusKm * 1000}::float8)
      AND ST_DWithin(${SALON_GEOG}, ${origin}, LEAST(p."radiusKm", ${maxRadiusKm}::float8) * 1000)
    ORDER BY distance_m ASC, s.id ASC
    LIMIT ${BRANCH_CAP}`;
  if (!rows.length) return [];

  const profiles = await prisma.homeServiceProfile.findMany({
    where: { salonId: { in: rows.map((r) => r.id) } },
    select: BRANCH_SELECT,
  });
  const byId = new Map(profiles.map((p) => [p.salonId, p]));
  const now = new Date();
  return rows.flatMap((r) => {
    const branch = byId.get(r.id);
    return branch && isBranchBookable(branch, branch.salon, audience, flags, now)
      ? [{ branch, distanceKm: km(r.distance_m) }]
      : [];
  });
};

/** One branch for `audience`, or HOME_SERVICE_UNAVAILABLE (404). */
const bookableBranch = async (salonId: string, audience: HomeAudience, includeTest: boolean) => {
  const [flags, branch] = await Promise.all([
    loadHomeFlags(),
    prisma.homeServiceProfile.findUnique({ where: { salonId }, select: BRANCH_SELECT }),
  ]);
  if (!branch || (branch.salon.isTest && !includeTest) || !isBranchBookable(branch, branch.salon, audience, flags)) {
    throw unavailable();
  }
  return branch;
};

/** Distance to `point` in km, and whether the branch's radius covers it. */
const reachOf = async (branch: Branch, point: Point | null) => {
  if (!point) return { distanceKm: null, servesYou: null };
  const origin = Prisma.sql`ST_SetSRID(ST_MakePoint(${point.lng}::float8, ${point.lat}::float8), 4326)::geography`;
  const [row] = await prisma.$queryRaw<{ distance_m: number | null }[]>`
    SELECT ST_Distance(${SALON_GEOG}, ${origin})::float8 AS distance_m
    FROM salons s
    WHERE s.id = ${branch.salonId} AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL`;
  if (row?.distance_m == null) return { distanceKm: null, servesYou: false };
  const maxRadiusKm = await getSetting("homeService.maxRadiusKm");
  return { distanceKm: km(row.distance_m), servesYou: row.distance_m <= effectiveRadiusKm(branch, maxRadiusKm) * 1000 };
};

const branchView = (b: Branch) => ({
  id: b.salon.id,
  name: b.salon.name,
  area: b.salon.area,
  city: b.salon.city,
  image: b.salon.images[0] ?? null,
  rating: b.salon.rating,
  totalReviews: b.salon.totalReviews,
  travelFeeMinor: b.travelFeeMinor,
  // 0 while the platform has no minimum order (`homeService.minOrderEnabled`).
  minOrderMinor: getSettingSync("homeService.minOrderEnabled") ? b.minOrderMinor : 0,
});

const liveOffering = (audience: HomeAudience): Prisma.HomeServiceOfferingWhereInput => ({
  audience,
  isActive: true,
  isDeleted: false,
});

// ---------------------------------------------------------------------------
// Salon detail flag
// ---------------------------------------------------------------------------

/**
 * Which sides of this branch a customer can book at home now: the branch is
 * bookable (`isBranchBookable`) and has a verified expert with a live offering
 * on that side. One profile read; the expert counts only when the branch is on.
 */
export const homeSidesOf = async (salon: { id: string } & Parameters<typeof isBranchBookable>[1]) => {
  const none = { ladies: false, gents: false };
  const profile = await prisma.homeServiceProfile.findUnique({
    where: { salonId: salon.id },
    select: { isOn: true, ladiesEnabled: true, gentsEnabled: true, status: true, pausedUntil: true },
  });
  if (!profile?.isOn) return none;
  const flags = await loadHomeFlags();
  const now = new Date();
  const side = async (audience: HomeAudience) =>
    isBranchBookable(profile, salon, audience, flags, now) &&
    (await prisma.homeExpert.count({
      where: {
        salonId: salon.id,
        ...eligibleExpertWhere(audience),
        offerings: { some: { offering: liveOffering(audience) } },
      },
    })) > 0;
  const [ladies, gents] = await Promise.all([side(HomeAudience.LADIES), side(HomeAudience.GENTS)]);
  return { ladies, gents };
};

// ---------------------------------------------------------------------------
// GET /catalog
// ---------------------------------------------------------------------------

/**
 * Coverage gaps (admin analytics): one count per out-of-area look, under the
 * area of the nearest salon. The `home_out_of_area` event can't carry an area:
 * event values are a fixed list, and these come from `salons`, so nothing
 * free-form enters. Fire and forget; a closed side is not a gap.
 */
const countOutOfArea = (point: Point, audience: HomeAudience) => {
  const work = async () => {
    const flags = await loadHomeFlags();
    if (!flags.enabled || !(audience === HomeAudience.LADIES ? flags.ladiesEnabled : flags.gentsEnabled)) return;
    const origin = Prisma.sql`ST_SetSRID(ST_MakePoint(${point.lng}::float8, ${point.lat}::float8), 4326)::geography`;
    const [nearest] = await prisma.$queryRaw<{ area: string }[]>`
      SELECT s.area FROM salons s
      WHERE s."isDeleted" = false AND s.status = 'ACTIVE' AND s."isTest" = false
        AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
      ORDER BY ${SALON_GEOG} <-> ${origin}
      LIMIT 1`;
    if (!nearest) return;
    incrementMetrics([
      { metric: "home.outOfArea" },
      { metric: "home.outOfArea", dimension: `area:${nearest.area.trim()}` },
      { metric: "home.outOfArea", dimension: `audience:${audience.toLowerCase()}` },
    ]);
  };
  void work().catch((err) => console.error("[analytics] home out-of-area count failed", err));
};

/** One bookable service row (per salon), with the eligible experts who do it. */
type OfferingRow = {
  name: string;
  category: HomeCategory;
  priceMinor: number;
  durationMin: number;
  image: string | null;
  salonId: string;
  expertIds: string[];
};

type CatalogOffering = {
  name: string;
  category: HomeCategory;
  minPriceMinor: number;
  durationMin: number;
  image: string | null;
  salonIds: Set<string>;
  expertIds: Set<string>;
};

/** One entry per category + name (case-insensitive), cheapest price and shortest duration. */
const aggregateOfferings = (rows: OfferingRow[]) => {
  const offerings = new Map<string, CatalogOffering>();
  for (const r of rows) {
    const key = `${r.category}:${r.name.trim().toLowerCase()}`;
    const o = offerings.get(key);
    if (!o) {
      offerings.set(key, {
        name: r.name.trim(),
        category: r.category,
        minPriceMinor: r.priceMinor,
        durationMin: r.durationMin,
        image: r.image,
        salonIds: new Set([r.salonId]),
        expertIds: new Set(r.expertIds),
      });
    } else {
      o.minPriceMinor = Math.min(o.minPriceMinor, r.priceMinor);
      o.durationMin = Math.min(o.durationMin, r.durationMin);
      o.image ??= r.image;
      o.salonIds.add(r.salonId);
      for (const e of r.expertIds) o.expertIds.add(e);
    }
  }
  return [...offerings.values()];
};

/** Services matching `query`, best first (typo matches only when nothing else matched). */
const searchOfferings = (offerings: CatalogOffering[], query: HomeQuery) => {
  const hits = offerings.flatMap((o) => {
    const match = matchFields(query, offeringFields(o));
    return match ? [{ o, match }] : [];
  });
  const { items, fuzzy } = preferExact(hits);
  items.sort(
    (a, b) =>
      b.match.score - a.match.score ||
      b.o.salonIds.size - a.o.salonIds.size ||
      a.o.minPriceMinor - b.o.minPriceMinor,
  );
  return { offerings: items.map((i) => i.o), fuzzy };
};

/**
 * Every eligible expert of these branches with their live services on this
 * side: what a search matches people against.
 */
const loadExpertPool = (salonIds: string[], audience: HomeAudience) =>
  prisma.homeExpert.findMany({
    where: {
      salonId: { in: salonIds },
      ...eligibleExpertWhere(audience),
      offerings: { some: { offering: liveOffering(audience) } },
    },
    select: {
      ...EXPERT_CARD_SELECT,
      offerings: {
        where: { offering: liveOffering(audience) },
        select: {
          offering: { select: { name: true, category: true, priceMinor: true, durationMin: true, images: true } },
        },
      },
    },
  });

type PoolExpert = Awaited<ReturnType<typeof loadExpertPool>>[number];
type ExpertOffering = { name: string; category: HomeCategory; priceMinor: number };

/**
 * Experts matching `query` on their own fields or their services, optionally
 * only over one category's services (as GET /experts?category does).
 */
const searchExperts = <E extends { name: string; headline: string | null; salonName: string; offerings: ExpertOffering[] }>(
  experts: E[],
  query: HomeQuery,
  category?: HomeCategory,
) => {
  const hits = experts.flatMap((e) => {
    const all: E["offerings"][number][] = e.offerings;
    const offerings = category ? all.filter((o) => o.category === category) : all;
    if (!offerings.length) return [];
    const match = matchExpert(query, personFields(e), offerings.map(offeringFields));
    return match ? [{ e, offerings, match }] : [];
  });
  return preferExact(hits);
};

/** The services an expert matched on, or all of them for a name search. */
const matchedOfferings = <O>(offerings: O[], matched: number[]) =>
  matched.length ? matched.map((i) => offerings[i]) : offerings;

const searchable = (e: PoolExpert, salonName: string) => ({
  ...e,
  name: e.staff.user.name,
  salonName,
  offerings: e.offerings.map((o) => o.offering),
});

export const getCatalog = async (viewer: Viewer, q: Query) => {
  const audience = audienceOf(q);
  const point = pointOf(q, true);
  const query = parseQuery(q.q);
  const isTest = await viewerIsTest(viewer);
  const branches = await servingBranches(point, audience, isTest);
  const echo = { q: query?.raw ?? null, fuzzy: false };
  if (!branches.length) {
    if (!isTest) countOutOfArea(point, audience);
    return { audience, outOfArea: true, ...echo, expertCount: 0, categories: [], offerings: [] };
  }
  const salonIds = branches.map((b) => b.branch.salonId);

  // Only what someone can actually book: an offering with a verified expert.
  const rows = await prisma.homeServiceOffering.findMany({
    where: {
      salonId: { in: salonIds },
      ...liveOffering(audience),
      experts: { some: { expert: eligibleExpertWhere(audience) } },
    },
    select: {
      name: true,
      category: true,
      durationMin: true,
      priceMinor: true,
      salonId: true,
      images: true,
      experts: { where: { expert: eligibleExpertWhere(audience) }, select: { expertId: true } },
    },
  });

  let offerings = aggregateOfferings(
    rows.map((r) => ({ ...r, image: r.images[0] ?? null, expertIds: r.experts.map((e) => e.expertId) })),
  );
  let fuzzy = false;
  if (query) ({ offerings, fuzzy } = searchOfferings(offerings, query));
  else offerings.sort((a, b) => b.salonIds.size - a.salonIds.size || a.minPriceMinor - b.minPriceMinor);

  // Per category: how many services and how many distinct experts (what the
  // experts list filtered to that category counts), plus the totals.
  const categories = new Map<
    HomeCategory,
    { category: HomeCategory; count: number; minPriceMinor: number; expertIds: Set<string> }
  >();
  const allExperts = new Set<string>();
  for (const o of offerings) {
    for (const id of o.expertIds) allExperts.add(id);
    const c = categories.get(o.category);
    if (!c) {
      categories.set(o.category, {
        category: o.category,
        count: 1,
        minPriceMinor: o.minPriceMinor,
        expertIds: new Set(o.expertIds),
      });
    } else {
      c.count += 1;
      c.minPriceMinor = Math.min(c.minPriceMinor, o.minPriceMinor);
      for (const id of o.expertIds) c.expertIds.add(id);
    }
  }

  // With a search, the expert counts are the people GET /experts?q finds (by
  // name, headline, salon or service), per category the way it filters them.
  if (query) {
    const salonName = new Map(branches.map((b) => [b.branch.salonId, b.branch.salon.name]));
    const pool = (await loadExpertPool(salonIds, audience)).map((e) => searchable(e, salonName.get(e.salonId) ?? ""));
    allExperts.clear();
    for (const { e } of searchExperts(pool, query).items) allExperts.add(e.id);
    for (const c of categories.values()) c.expertIds.clear();
    const inPool = new Set(pool.flatMap((e) => e.offerings.map((o) => o.category)));
    for (const category of inPool) {
      for (const { e, offerings: own, match } of searchExperts(pool, query, category).items) {
        // Found by name only, no service matched in it: the chip still filters the experts.
        let c = categories.get(category);
        if (!c) {
          c = { category, count: 0, minPriceMinor: Number.MAX_SAFE_INTEGER, expertIds: new Set() };
          categories.set(category, c);
        }
        c.expertIds.add(e.id);
        if (!c.count) {
          const prices = matchedOfferings(own, match.matched).map((o) => o.priceMinor);
          c.minPriceMinor = Math.min(c.minPriceMinor, ...prices);
        }
      }
    }
    for (const [k, c] of categories) if (!c.count && !c.expertIds.size) categories.delete(k);
    if (!isTest) recordSearchTerm(query.raw, "HOME", !offerings.length && !allExperts.size);
  }

  return {
    audience,
    outOfArea: false,
    q: echo.q,
    fuzzy,
    expertCount: allExperts.size,
    categories: [...categories.values()]
      .map(({ expertIds, ...c }) => ({ ...c, expertCount: expertIds.size }))
      .sort((a, b) => b.count - a.count || b.expertCount - a.expertCount),
    offerings: offerings.map(({ salonIds, expertIds, ...o }) => ({
      ...o,
      salonCount: salonIds.size,
      expertCount: expertIds.size,
    })),
  };
};

// ---------------------------------------------------------------------------
// GET /experts
// ---------------------------------------------------------------------------

const categoryOf = (q: Query): HomeCategory | undefined => {
  const v = str(q.category).toUpperCase();
  if (!v) return undefined;
  if (!(v in HomeCategory)) throw new ApiError(StatusCodes.BAD_REQUEST, "Unknown category");
  return v as HomeCategory;
};

/** `relevance` (best match) is the default with a search and means `rating` without one. */
const sortOf = (q: Query, searching: boolean) => {
  const v = str(q.sort) || (searching ? "relevance" : "rating");
  if (v !== "relevance" && v !== "rating" && v !== "distance" && v !== "soonest") {
    throw new ApiError(StatusCodes.BAD_REQUEST, "sort must be relevance, rating, distance or soonest");
  }
  return v === "relevance" && !searching ? "rating" : v;
};

/** At most this many matched service names on an expert card. */
const MATCHED_SERVICES_MAX = 3;

const EXPERT_CARD_SELECT = {
  id: true,
  salonId: true,
  headline: true,
  rating: true,
  totalReviews: true,
  completedJobs: true,
  languages: true,
  staff: { select: { user: { select: { name: true, profilePhoto: true } } } },
} satisfies Prisma.HomeExpertSelect;

export const listExperts = async (viewer: Viewer, q: Query) => {
  const audience = audienceOf(q);
  const point = pointOf(q, true);
  const category = categoryOf(q);
  const query = parseQuery(q.q);
  const sort = sortOf(q, !!query);
  const page = pageOf(q);

  const branches = await servingBranches(point, audience, await viewerIsTest(viewer));
  const empty = { audience, outOfArea: !branches.length, sort, q: query?.raw ?? null, fuzzy: false, experts: [] };
  if (!branches.length) return { meta: { page, limit: PAGE_SIZE, total: 0 }, data: empty };
  const branchById = new Map(branches.map((b) => [b.branch.salonId, b]));

  const offeringWhere: Prisma.HomeServiceOfferingWhereInput = { ...liveOffering(audience), ...(category ? { category } : {}) };
  const rows = await prisma.homeExpert.findMany({
    where: {
      salonId: { in: [...branchById.keys()] },
      ...eligibleExpertWhere(audience),
      offerings: { some: { offering: offeringWhere } },
    },
    select: {
      ...EXPERT_CARD_SELECT,
      offerings: {
        where: { offering: offeringWhere },
        select: { offering: { select: { name: true, category: true, priceMinor: true, durationMin: true } } },
      },
    },
  });

  // A search keeps the experts it matches (on name, headline, salon or one of
  // these services) and prices each card on the services it matched.
  type Offering = (typeof rows)[number]["offerings"][number]["offering"];
  const people = rows.map((e) => ({
    ...e,
    name: e.staff.user.name,
    salonName: branchById.get(e.salonId)!.branch.salon.name,
    offerings: e.offerings.map((o) => o.offering),
  }));
  let fuzzy = false;
  let found: Array<{ e: (typeof people)[number]; own: Offering[]; score: number; searched: boolean }> = people.map(
    (e) => ({ e, own: e.offerings, score: 0, searched: false }),
  );
  if (query) {
    const hits = searchExperts(people, query);
    fuzzy = hits.fuzzy;
    found = hits.items.map(({ e, offerings, match }) => ({
      e,
      own: matchedOfferings(offerings, match.matched),
      score: match.score,
      searched: match.matched.length > 0,
    }));
  }

  let cards = found.map(({ e, own, score, searched }) => {
    const b = branchById.get(e.salonId)!;
    return {
      id: e.id,
      name: e.name,
      photo: e.staff.user.profilePhoto,
      headline: e.headline,
      languages: e.languages,
      rating: e.rating,
      totalReviews: e.totalReviews,
      completedJobs: e.completedJobs,
      verified: true,
      salon: { id: b.branch.salon.id, name: b.branch.salon.name, area: b.branch.salon.area },
      distanceKm: b.distanceKm,
      fromPriceMinor: Math.min(...own.map((o) => o.priceMinor)),
      ...(query
        ? {
            // The services the search found on this expert; empty for a name match.
            matchedServices: searched
              ? [...new Set(own.map((o) => o.name.trim()))].slice(0, MATCHED_SERVICES_MAX)
              : [],
          }
        : {}),
      shortestMin: Math.min(...own.map((o) => o.durationMin)),
      score,
      soonestAt: null as Date | null,
    };
  });

  type Card = (typeof cards)[number];
  const byDistance = (a: Card, b: Card) => a.distanceKm - b.distanceKm || b.rating - a.rating || a.id.localeCompare(b.id);
  const byRating = (a: Card, b: Card) => b.rating - a.rating || b.totalReviews - a.totalReviews || byDistance(a, b);
  cards.sort(
    sort === "relevance" ? (a, b) => b.score - a.score || byRating(a, b) : sort === "rating" ? byRating : byDistance,
  );

  const total = cards.length;
  cards = cards.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Soonest: only this page's experts (≤ 20) are computed, nearest first,
  // then the page is ordered by their first free start in the next 2 days.
  if (sort === "soonest" && cards.length) {
    const now = new Date();
    const settings = await loadSlotSettings();
    const days = Array.from({ length: Math.min(SOONEST_DAYS, settings.bookingWindowDays) }, (_, n) => addDays(dhakaDay(now), n));
    const loaded = await loadExpertDays(
      cards.map((c) => c.id),
      days,
      { now, settings },
    );
    for (const c of cards) {
      for (const day of days) {
        const input = loaded.get(c.id)?.get(day);
        const first = input ? computeSlots({ ...input, durationMin: c.shortestMin })[0] : undefined;
        if (first) {
          c.soonestAt = first;
          break;
        }
      }
    }
    cards.sort(
      (a, b) =>
        (a.soonestAt?.getTime() ?? Infinity) - (b.soonestAt?.getTime() ?? Infinity) || byDistance(a, b),
    );
  }

  return {
    meta: { page, limit: PAGE_SIZE, total },
    data: {
      ...empty,
      outOfArea: false,
      fuzzy,
      experts: cards.map(({ shortestMin: _s, score: _score, soonestAt, ...c }) => ({
        ...c,
        ...(sort === "soonest" ? { soonestAt, soonestLabel: soonestAt ? slotLabel(soonestAt) : null } : {}),
      })),
    },
  };
};

// ---------------------------------------------------------------------------
// GET /search (typeahead)
// ---------------------------------------------------------------------------

const SUGGEST_LIMIT = 5;

/**
 * As-you-type suggestions for one side at one point: the best few services
 * and experts for `q`, with how many of each the full lists would show. Same
 * matching as GET /catalog?q and GET /experts?q. Keystrokes are not recorded
 * as search terms; the list they lead to is.
 */
export const searchSuggestions = async (viewer: Viewer, q: Query) => {
  const audience = audienceOf(q);
  const point = pointOf(q, true);
  const query = parseQuery(q.q);
  const none = {
    audience,
    q: query?.raw ?? null,
    outOfArea: false,
    fuzzy: false,
    totals: { services: 0, experts: 0 },
    services: [],
    experts: [],
  };
  if (!query) return none;

  const branches = await servingBranches(point, audience, await viewerIsTest(viewer));
  if (!branches.length) return { ...none, outOfArea: true };
  const branchById = new Map(branches.map((b) => [b.branch.salonId, b]));
  const pool = (await loadExpertPool([...branchById.keys()], audience)).map((e) =>
    searchable(e, branchById.get(e.salonId)!.branch.salon.name),
  );

  // Services: the catalog's grouping, built from the same experts.
  const services = searchOfferings(
    aggregateOfferings(
      pool.flatMap((e) =>
        e.offerings.map((o) => ({ ...o, image: o.images[0] ?? null, salonId: e.salonId, expertIds: [e.id] })),
      ),
    ),
    query,
  );

  const experts = searchExperts(pool, query);
  const rankedExperts = experts.items
    .map(({ e, offerings, match }) => ({ e, offerings, match, b: branchById.get(e.salonId)! }))
    .sort(
      (x, y) =>
        y.match.score - x.match.score ||
        y.e.rating - x.e.rating ||
        x.b.distanceKm - y.b.distanceKm ||
        x.e.id.localeCompare(y.e.id),
    );

  const anything = services.offerings.length + experts.items.length > 0;
  return {
    ...none,
    // Every suggestion shown is a close match, not what was typed.
    fuzzy:
      anything &&
      (services.fuzzy || !services.offerings.length) &&
      (experts.fuzzy || !experts.items.length),
    totals: { services: services.offerings.length, experts: experts.items.length },
    services: services.offerings.slice(0, SUGGEST_LIMIT).map((o) => ({
      name: o.name,
      category: o.category,
      minPriceMinor: o.minPriceMinor,
      expertCount: o.expertIds.size,
    })),
    experts: rankedExperts.slice(0, SUGGEST_LIMIT).map(({ e, offerings, match, b }) => ({
      id: e.id,
      name: e.name,
      photo: e.staff.user.profilePhoto,
      rating: e.rating,
      totalReviews: e.totalReviews,
      salon: { name: b.branch.salon.name, area: b.branch.salon.area },
      distanceKm: b.distanceKm,
      /** The service the search found on them; null for a name match. */
      matchedService: match.matched.length ? offerings[match.matched[0]].name.trim() : null,
    })),
  };
};

// ---------------------------------------------------------------------------
// GET /experts/:id
// ---------------------------------------------------------------------------

const DISCLAIMER_KEY = {
  FREE: "homeService.disclaimer.free",
  WINDOW: "homeService.disclaimer.window",
  NON_REFUNDABLE: "homeService.disclaimer.nonRefundable",
} as const;

export const getExpert = async (viewer: Viewer, id: string, q: Query) => {
  const expertId = idOf(id, "id");
  const point = pointOf(q, false);
  const includeTest = await viewerIsTest(viewer);

  const head = await prisma.homeExpert.findUnique({ where: { id: expertId }, select: { audience: true } });
  if (!head) throw ApiError.withCode(StatusCodes.NOT_FOUND, "This expert isn't available.", "EXPERT_UNAVAILABLE");
  const audience = head.audience;

  const expert = await prisma.homeExpert.findFirst({
    where: { id: expertId, ...eligibleExpertWhere(audience) },
    select: {
      ...EXPERT_CARD_SELECT,
      audience: true,
      staff: { select: { speciality: true, experience: true, bio: true, user: { select: { name: true, profilePhoto: true } } } },
      offerings: {
        where: { offering: liveOffering(audience) },
        select: {
          offering: {
            select: {
              id: true,
              category: true,
              name: true,
              description: true,
              kitNote: true,
              durationMin: true,
              priceMinor: true,
              images: true,
              sortOrder: true,
            },
          },
        },
      },
    },
  });
  if (!expert || !expert.offerings.length) {
    throw ApiError.withCode(StatusCodes.NOT_FOUND, "This expert isn't available.", "EXPERT_UNAVAILABLE");
  }

  const branch = await bookableBranch(expert.salonId, audience, includeTest).catch(() => {
    throw ApiError.withCode(StatusCodes.NOT_FOUND, "This expert isn't available.", "EXPERT_UNAVAILABLE");
  });
  const [reach, policy, reviews] = await Promise.all([
    reachOf(branch, point),
    loadPolicyInForce(),
    listExpertReviews(expert.id, Number(str(q.reviewPage)) || 1),
  ]);
  const disclaimer = await getSetting(DISCLAIMER_KEY[policy.customerCancelPolicy]);

  const menu = expert.offerings
    .map((o) => o.offering)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map(({ sortOrder: _s, ...o }) => o);

  return {
    id: expert.id,
    audience,
    name: expert.staff.user.name,
    photo: expert.staff.user.profilePhoto,
    headline: expert.headline,
    bio: expert.staff.bio,
    speciality: expert.staff.speciality,
    experienceYears: expert.staff.experience,
    languages: expert.languages,
    rating: expert.rating,
    totalReviews: expert.totalReviews,
    completedJobs: expert.completedJobs,
    verified: true,
    salon: branchView(branch),
    menu,
    distanceKm: reach.distanceKm,
    servesYou: reach.servesYou,
    policy: { ...policy, disclaimer },
    // PUBLISHED home reviews, paged with ?reviewPage (GET /experts/:id/reviews pages them alone).
    reviews,
  };
};

// ---------------------------------------------------------------------------
// GET /salons/:salonId/menu
// ---------------------------------------------------------------------------

/**
 * One branch's home menu for `audience`: what a customer picks from when they
 * choose "At home" on the salon's own page or in the chat. Every service is
 * offered by at least one eligible expert, and lists who does it, so the
 * caller can start the booking with "any available expert" on an expert who
 * covers the whole cart. Prices and the advance share are the ones the quote
 * will use (`homeService.advancePercent`, the clamped travel fee); the quote
 * stays the authority.
 */
export const getSalonMenu = async (viewer: Viewer, salonIdRaw: string, q: Query) => {
  const salonId = idOf(salonIdRaw, "salonId");
  const audience = audienceOf(q);
  const point = pointOf(q, false);
  const branch = await bookableBranch(salonId, audience, await viewerIsTest(viewer));

  const experts = await prisma.homeExpert.findMany({
    where: {
      salonId,
      ...eligibleExpertWhere(audience),
      offerings: { some: { offering: liveOffering(audience) } },
    },
    select: {
      ...EXPERT_CARD_SELECT,
      offerings: { where: { offering: liveOffering(audience) }, select: { offeringId: true } },
    },
    orderBy: [{ rating: "desc" }, { totalReviews: "desc" }, { id: "asc" }],
  });
  if (!experts.length) throw unavailable();

  const offeredIds = [...new Set(experts.flatMap((e) => e.offerings.map((o) => o.offeringId)))];
  const [offerings, reach, advancePercent, travelFeeMaxMinor] = await Promise.all([
    prisma.homeServiceOffering.findMany({
      where: { id: { in: offeredIds }, salonId, ...liveOffering(audience) },
      select: {
        id: true,
        category: true,
        name: true,
        description: true,
        kitNote: true,
        durationMin: true,
        priceMinor: true,
        images: true,
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    reachOf(branch, point),
    getSetting("homeService.advancePercent"),
    getSetting("homeService.travelFeeMaxMinor"),
  ]);
  if (!offerings.length) throw unavailable();

  const doneBy = (offeringId: string) =>
    experts.filter((e) => e.offerings.some((o) => o.offeringId === offeringId)).map((e) => e.id);

  return {
    salon: {
      ...branchView(branch),
      // What the quote will charge: a fee saved above a since-lowered cap is clamped.
      travelFeeMinor: Math.max(0, Math.min(branch.travelFeeMinor, travelFeeMaxMinor)),
    },
    audience,
    advancePercent,
    distanceKm: reach.distanceKm,
    servesYou: reach.servesYou,
    menu: offerings.map(({ images, ...o }) => ({ ...o, image: images[0] ?? null, expertIds: doneBy(o.id) })),
    experts: experts.map((e) => ({
      id: e.id,
      name: e.staff.user.name,
      photo: e.staff.user.profilePhoto,
      headline: e.headline,
      rating: e.rating,
      totalReviews: e.totalReviews,
      completedJobs: e.completedJobs,
      offeringIds: e.offerings.map((o) => o.offeringId),
    })),
  };
};

/** GET /experts/:id/reviews?page: only for an expert the public can see. */
export const getExpertReviews = async (id: string, q: Query) => {
  const expertId = idOf(id, "id");
  const e = await prisma.homeExpert.findFirst({ where: { id: expertId, removedAt: null }, select: { id: true } });
  if (!e) throw ApiError.withCode(StatusCodes.NOT_FOUND, "This expert isn't available.", "EXPERT_UNAVAILABLE");
  return listExpertReviews(e.id, Number(str(q.page)) || 1);
};

// ---------------------------------------------------------------------------
// GET /availability, GET /availability/days
// ---------------------------------------------------------------------------

/** Cart, branch and reach shared by both availability reads. */
const availabilityContext = async (viewer: Viewer, q: Query) => {
  const offeringIds = offeringIdsOf(q);
  const expertId = str(q.expertId) ? idOf(q.expertId, "expertId") : undefined;
  const salonId = str(q.salonId) ? idOf(q.salonId, "salonId") : undefined;
  if (!expertId && !salonId) throw new ApiError(StatusCodes.BAD_REQUEST, "Pass expertId or salonId");
  const point = pointOf(q, false);

  const cart = await loadCart(offeringIds);
  if (salonId && salonId !== cart.salonId) {
    throw ApiError.withCode(StatusCodes.BAD_REQUEST, "These services belong to another salon.", "INVALID_CART");
  }
  const branch = await bookableBranch(cart.salonId, cart.audience, await viewerIsTest(viewer));
  const reach = await reachOf(branch, point);
  return { offeringIds, expertId, outOfArea: reach.servesYou === false };
};

export const getAvailability = async (viewer: Viewer, q: Query) => {
  const date = str(q.date);
  if (!isDay(date)) throw ApiError.withCode(StatusCodes.BAD_REQUEST, "date must be YYYY-MM-DD", "INVALID_TIME");
  const ctx = await availabilityContext(viewer, q);
  if (ctx.outOfArea) return { date, outOfArea: true, slots: [] };

  const { byDay } = await availableFor({ expertId: ctx.expertId, offeringIds: ctx.offeringIds, days: [date] });
  return {
    date,
    outOfArea: false,
    slots: (byDay.get(date) ?? []).map((s) => ({
      startAt: s.startAt,
      label: slotLabel(s.startAt),
      period: slotPeriod(s.startAt),
      ...(ctx.expertId ? {} : { expertIds: s.expertIds }),
    })),
  };
};

export const getAvailabilityDays = async (viewer: Viewer, q: Query) => {
  const ctx = await availabilityContext(viewer, q);
  const now = new Date();
  const days = windowDays(await loadSlotSettings(), now);
  const today = dhakaDay(now);
  if (ctx.outOfArea) {
    return { outOfArea: true, days: days.map((date) => ({ date, label: dayLabel(date, today), hasSlots: false })) };
  }

  const { byDay } = await availableFor({ expertId: ctx.expertId, offeringIds: ctx.offeringIds, days, now });
  return {
    outOfArea: false,
    days: days.map((date) => ({ date, label: dayLabel(date, today), hasSlots: (byDay.get(date) ?? []).length > 0 })),
  };
};
