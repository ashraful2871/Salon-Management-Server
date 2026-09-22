import { Prisma, ServiceCategory } from "@prisma/client";
import prisma from "../../shared/prisma";
import { formatBDT } from "../../utils/money";
import { SALON_GEOG } from "../Salon/salon.geo";
import { CATEGORY_LABELS, SALON_TIME_ZONE } from "./ai.constants";
import { toVectorLiteral } from "./ai.gemini";
import { SearchIntent, districtsOfArea, normaliseText } from "./ai.intent";

/**
 * Hybrid retrieval and ranking.
 *
 * Every ACTIVE salon is a candidate - a missing embedding costs a salon its
 * semantic score, never its place in the results. Each candidate gets a few
 * signals, each normalised to 0..1 (min-max for similarity, since this
 * model's cosine scores bunch between ~0.6 and ~0.85 whatever the query):
 *
 *   service   offers what was asked for (category and/or named service)
 *   place     in the named area, or distance from the customer / a place
 *   semantic  embedding similarity to the query
 *   quality   Bayesian-averaged rating, so one 5-star review is not "best"
 *   price     cheaper is better, when the customer cares about price
 *
 * The weighted mean of the signals the query uses orders results; what the
 * customer asked for explicitly (service, place, price, rating, open now)
 * decides the tier - "best" meets all of it, "partial" some. Nothing that
 * meets none of it is shown unless nothing else exists, and then as an
 * honest "alternative".
 */

export type Origin = {
  lat: number;
  lng: number;
  label: string;
  /** "user": the customer's saved location. "place": a place they named, geocoded. */
  source: "user" | "place";
};

type ServiceRow = {
  id: string;
  name: string;
  category: ServiceCategory;
  priceMinor: number;
  duration: number;
};

type CandidateRow = {
  id: string;
  name: string;
  description: string | null;
  address: string;
  area: string;
  district: string;
  division: string;
  city: string;
  images: string[];
  rating: number;
  totalReviews: number;
  phone: string;
  operatingHours: unknown;
  latitude: number | null;
  longitude: number | null;
  locationAccuracy: string | null;
  similarity: number | null;
  distanceMeters: number | null;
  services: ServiceRow[];
};

export type MatchType = "best" | "partial" | "alternative";

export type ReasonKind =
  | "name"
  | "service"
  | "place"
  | "distance"
  | "price"
  | "rating"
  | "open";

export type Reason = { kind: ReasonKind; text: string };

export type RankedSalon = CandidateRow & {
  score: number;
  matchType: MatchType;
  openNow: boolean | null;
  matchedServices: ServiceRow[];
  /** Why it is shown ("Classic Haircut · ৳120", "In Dhanmondi"). */
  reasons: Reason[];
  /** What it does not meet ("No haircut listed"). */
  missing: Reason[];
};

type Constraint = "service" | "place" | "price" | "rating" | "open";

/** Beyond this many active salons, the least similar are not scored. */
const MAX_CANDIDATES = 1_000;
/** "Near me" is met within this distance; further ones still rank, lower. */
const NEAR_USER_RADIUS_M = 7_000;
/** A named place that is not one of our areas: "in it" means about this close. */
const NEAR_PLACE_RADIUS_M = 3_000;
/** Distance at which the place signal halves. */
const DISTANCE_HALF_M = 2_000;
/** Bayesian prior: a salon with no reviews is treated as a 3.5 from 5 reviews. */
const PRIOR_RATING = 3.5;
const PRIOR_REVIEWS = 5;
const ALTERNATIVES = 3;

export const CLOSEST_MATCHES_NOTE = "These are the closest matches.";
export const POPULAR_INSTEAD_NOTE = "Here are some popular salons instead.";

const BASE_WEIGHTS = {
  service: 0.32,
  place: 0.24,
  semantic: 0.22,
  quality: 0.12,
  price: 0.1,
};

/**
 * The word that makes a service the obvious example of its category, so a
 * search for a haircut shows "Classic Haircut" rather than the cheaper
 * "Beard Trim" filed under the same category.
 */
const CATEGORY_CORE_WORDS: Record<ServiceCategory, string[]> = {
  HAIRCUT: ["haircut", "cut"],
  STYLING: ["style", "styling", "blow", "blowout"],
  COLORING: ["colour", "color", "coloring", "colouring", "dye", "highlight"],
  TREATMENT: ["treatment", "keratin", "rebonding", "smoothing"],
  SPA: ["spa"],
  FACIAL: ["facial"],
  MANICURE: ["manicure", "nail"],
  PEDICURE: ["pedicure"],
  MAKEUP: ["makeup", "make"],
  WAXING: ["wax", "waxing", "threading"],
  MASSAGE: ["massage"],
  OTHER: [],
};

// Words in salon names that say nothing about which salon it is.
const NAME_NOISE = new Set(
  (
    "the and salon salons beauty parlour parlor spa studio lounge bar hair " +
    "care house point center centre style styles zone bd ltd by of n & makeover"
  ).split(" "),
);

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

const fetchCandidates = (vector: number[] | null, origin: Origin | null) => {
  const similarity = vector
    ? Prisma.sql`CASE WHEN s.embedding IS NULL THEN NULL
        ELSE (1 - (s.embedding <=> ${toVectorLiteral(vector)}::vector))::float8 END`
    : Prisma.sql`NULL::float8`;

  const distance = origin
    ? Prisma.sql`CASE WHEN s.latitude IS NULL OR s.longitude IS NULL THEN NULL
        ELSE ST_Distance(${SALON_GEOG},
          ST_SetSRID(ST_MakePoint(${origin.lng}::float8, ${origin.lat}::float8), 4326)::geography)::float8 END`
    : Prisma.sql`NULL::float8`;

  return prisma.$queryRaw<CandidateRow[]>`
    SELECT
      s.id, s.name, s.description, s.address, s.area, s.district, s.division,
      s.city, s.images, s.rating, s."totalReviews", s.phone, s."operatingHours",
      s.latitude, s.longitude, s."locationAccuracy"::text AS "locationAccuracy",
      ${similarity} AS similarity,
      ${distance} AS "distanceMeters",
      COALESCE(svc.services, '[]'::json) AS services
    FROM salons s
    LEFT JOIN LATERAL (
      SELECT json_agg(
               json_build_object(
                 'id', sv.id, 'name', sv.name, 'category', sv.category,
                 'priceMinor', sv."priceMinor", 'duration', sv.duration
               ) ORDER BY sv."priceMinor", sv.name
             ) AS services
      FROM services sv
      WHERE sv."salonId" = s.id AND sv."isDeleted" = false AND sv."isActive" = true
    ) svc ON true
    WHERE s."isDeleted" = false AND s.status = 'ACTIVE'
    ORDER BY similarity DESC NULLS LAST, s.rating DESC, s.id
    LIMIT ${MAX_CANDIDATES}`;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const same = (a?: string | null, b?: string | null) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

const tokens = (text: string) =>
  normaliseText(text)
    .split(/[^a-z0-9ঀ-৿]+/)
    .filter(Boolean)
    .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t));

/** Every word of `term` appears in `text` ("hair spa" in "Deep Hair Spa"). */
const containsTerm = (text: string, term: string) => {
  const have = new Set(tokens(text));
  const want = tokens(term);
  return want.length > 0 && want.every((t) => have.has(t));
};

export const formatDistance = (meters: number, approximate = false) => {
  const prefix = approximate ? "~" : "";
  if (meters < 1000) return `${prefix}${Math.max(50, Math.round(meters / 50) * 50)} m`;
  const km = meters / 1000;
  return `${prefix}${km < 9.95 ? km.toFixed(1) : Math.round(km)} km`;
};

const DAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const dhakaClock = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SALON_TIME_ZONE,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    day: get("weekday").toLowerCase(),
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
};

const toMinutes = (value: unknown) => {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value ?? ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

/**
 * Open right now in Dhaka? null when the salon has not published hours -
 * "unknown" must not read as "closed".
 */
export const isOpenNow = (hours: unknown, now = new Date()): boolean | null => {
  if (!hours || typeof hours !== "object") return null;
  const clock = dhakaClock(now);
  const today = (hours as Record<string, unknown>)[clock.day];
  if (!today || typeof today !== "object") return false;

  const day = today as Record<string, unknown>;
  if (day.closed === true || day.isClosed === true) return false;

  const open = toMinutes(day.open);
  const close = toMinutes(day.close);
  if (open === null || close === null) return null;

  return close >= open
    ? clock.minutes >= open && clock.minutes <= close
    : clock.minutes >= open || clock.minutes <= close; // past midnight
};

const bayesianRating = (rating: number, reviews: number) =>
  (rating * reviews + PRIOR_RATING * PRIOR_REVIEWS) / (reviews + PRIOR_REVIEWS);

const minMax = (values: number[]) => {
  const low = Math.min(...values);
  const high = Math.max(...values);
  return (value: number) => (high - low < 0.02 ? 0.5 : (value - low) / (high - low));
};

const priceText = (intent: SearchIntent) => {
  if (intent.maxPriceMinor !== null && intent.minPriceMinor !== null) {
    return `${formatBDT(intent.minPriceMinor)}-${formatBDT(intent.maxPriceMinor)}`;
  }
  if (intent.maxPriceMinor !== null) return `under ${formatBDT(intent.maxPriceMinor)}`;
  if (intent.minPriceMinor !== null) return `over ${formatBDT(intent.minPriceMinor)}`;
  return "";
};

const joinWords = (words: string[]) =>
  words.length <= 1
    ? words.join("")
    : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export type RankInput = {
  intent: SearchIntent;
  vector: number[] | null;
  origin: Origin | null;
  limit: number;
  query: string;
};

export type RankOutput = {
  salons: RankedSalon[];
  notes: string[];
  counts: { candidates: number; best: number; partial: number };
};

export const rankSalons = async ({
  intent,
  vector,
  origin,
  limit,
  query,
}: RankInput): Promise<RankOutput> => {
  const candidates = await fetchCandidates(vector, origin);
  if (!candidates.length) {
    return { salons: [], notes: [], counts: { candidates: 0, best: 0, partial: 0 } };
  }

  const categoryLabels = intent.categories.map((c) => CATEGORY_LABELS[c]);
  const wantsService = intent.categories.length > 0 || intent.serviceTerms.length > 0;
  const wantsPrice = intent.maxPriceMinor !== null || intent.minPriceMinor !== null;
  const serviceWords = categoryLabels.length
    ? joinWords(categoryLabels.map((l) => l.toLowerCase()))
    : joinWords(intent.serviceTerms);

  // Where "place" comes from: a named area we have salons in, a named place
  // we geocoded, or the customer's own location ("near me"). A saved location
  // without "near me" only nudges the order, like any map app.
  const placeMode: "named" | "radius" | "bias" | "none" = intent.place
    ? "named"
    : origin && (intent.nearMe || origin.source === "place")
      ? "radius"
      : origin
        ? "bias"
        : "none";
  const radius = origin?.source === "place" ? NEAR_PLACE_RADIUS_M : NEAR_USER_RADIUS_M;
  const placeWords =
    placeMode === "named"
      ? `in ${intent.place!.label}`
      : placeMode === "radius"
        ? origin!.source === "user"
          ? "near you"
          : `near ${origin!.label}`
        : "";

  const areaDistricts = intent.place?.area
    ? await districtsOfArea(intent.place.area)
    : [];

  const requested: Constraint[] = [];
  if (wantsService) requested.push("service");
  if (placeMode === "named" || placeMode === "radius") requested.push("place");
  if (wantsPrice) requested.push("price");
  if (intent.minRating !== null) requested.push("rating");
  if (intent.openNow) requested.push("open");

  const sims = candidates
    .map((c) => c.similarity)
    .filter((s): s is number => typeof s === "number");
  const semanticScale = sims.length ? minMax(sims) : null;
  const semanticOf = (c: CandidateRow) =>
    semanticScale === null
      ? undefined
      : typeof c.similarity === "number"
        ? semanticScale(c.similarity)
        : 0.4;

  // Min-max stretches any spread to 0..1, so "salon near me" - where every
  // salon is equally "a salon" and cosines differ by 0.02 - would let noise
  // outrank a 4.9 from 500 reviews. The semantic signal counts only as much
  // as it actually separates the salons: nothing below a 0.02 spread, fully
  // from 0.10 up.
  const semanticSpread = sims.length ? Math.max(...sims) - Math.min(...sims) : 0;
  const semanticConfidence = Math.min(Math.max((semanticSpread - 0.02) / 0.08, 0), 1);

  const priceOk = (priceMinor: number) =>
    (intent.maxPriceMinor === null || priceMinor <= intent.maxPriceMinor) &&
    (intent.minPriceMinor === null || priceMinor >= intent.minPriceMinor);

  const queryTokens = new Set(tokens(query));
  const now = new Date();

  const evaluated = candidates.map((c) => {
    const services = Array.isArray(c.services) ? c.services : [];

    // --- service. Within budget first, then named ("keratin"), then the
    // obvious example of the category, then cheapest - the first one is
    // what the card shows.
    const matchedServices = wantsService
      ? services
          .map((sv) => {
            const words = tokens(sv.name);
            return {
              sv,
              term: intent.serviceTerms.some((t) => containsTerm(sv.name, t)),
              category: intent.categories.includes(sv.category),
              core: CATEGORY_CORE_WORDS[sv.category].some((w) => words.includes(w)),
              affordable: priceOk(sv.priceMinor),
            };
          })
          .filter((m) => m.term || m.category)
          .sort(
            (a, b) =>
              Number(b.affordable) - Number(a.affordable) ||
              Number(b.term) - Number(a.term) ||
              Number(b.core) - Number(a.core) ||
              a.sv.priceMinor - b.sv.priceMinor,
          )
          .map((m) => m.sv)
      : [];

    let serviceScore: number | undefined;
    let mentionsOnly = false;
    if (wantsService) {
      const covered = intent.categories.filter((cat) =>
        services.some((sv) => sv.category === cat),
      ).length;
      const termHit = matchedServices.some((sv) =>
        intent.serviceTerms.some((t) => containsTerm(sv.name, t)),
      );
      serviceScore = intent.categories.length ? covered / intent.categories.length : 0;
      if (termHit) serviceScore = Math.min(1, Math.max(serviceScore, 0.7) + 0.3);

      if (serviceScore === 0) {
        // No services listed, but the salon calls itself a spa or a barber.
        const blurb = `${c.name} ${c.description ?? ""}`;
        mentionsOnly =
          intent.serviceTerms.some((t) => containsTerm(blurb, t)) ||
          categoryLabels.some((l) => containsTerm(blurb, l));
        if (mentionsOnly) serviceScore = 0.35;
      }
    }

    // --- place
    let placeScore: number | undefined;
    let placeMet = false;
    let sameDistrict = false;
    if (placeMode === "named") {
      const p = intent.place!;
      placeMet =
        (!p.area || same(c.area, p.area)) &&
        (!p.district || same(c.district, p.district)) &&
        (!p.city || same(c.city, p.city)) &&
        (!p.division || same(c.division, p.division));
      sameDistrict = !placeMet && areaDistricts.some((d) => same(d, c.district));
      placeScore = placeMet ? 1 : sameDistrict ? 0.45 : 0;
    } else if (placeMode === "radius" || placeMode === "bias") {
      const d = c.distanceMeters;
      placeScore = d === null ? 0 : 1 / (1 + Math.pow(d / DISTANCE_HALF_M, 1.5));
      placeMet = placeMode === "radius" && d !== null && d <= radius;
    }

    // --- price reference: the cheapest thing they would actually book here
    const priced = (wantsService ? matchedServices : services).map((sv) => sv.priceMinor);
    const cheapest = priced.length ? Math.min(...priced) : null;
    const priceMet =
      wantsPrice && (wantsService ? matchedServices : services).some((sv) => priceOk(sv.priceMinor));

    const reviews = Number(c.totalReviews) || 0;
    const rating = Number(c.rating) || 0;
    const openNow = isOpenNow(c.operatingHours, now);

    // --- name: someone typing a salon's name wants that salon
    const nameTokens = tokens(c.name).filter((t) => !NAME_NOISE.has(t));
    const nameHits = nameTokens.filter((t) => queryTokens.has(t));
    const nameScore =
      nameTokens.length && nameHits.some((t) => t.length >= 4)
        ? nameHits.length / nameTokens.length
        : 0;

    const met = new Set<Constraint>();
    if (wantsService && matchedServices.length > 0) met.add("service");
    if (placeMet) met.add("place");
    if (priceMet) met.add("price");
    if (intent.minRating !== null && reviews > 0 && rating >= intent.minRating) met.add("rating");
    if (intent.openNow && openNow === true) met.add("open");

    return {
      c,
      services,
      matchedServices,
      serviceScore,
      mentionsOnly,
      placeScore,
      placeMet,
      sameDistrict,
      cheapest,
      reviews,
      rating,
      openNow,
      nameScore,
      met,
    };
  });

  // Cheaper is better only among salons that list a price; one that lists
  // none is not assumed cheap.
  const wantsCheap = intent.budget || intent.sortBy === "price";
  const priceScale = (() => {
    const prices = evaluated.map((e) => e.cheapest).filter((p): p is number => p !== null);
    return prices.length ? minMax(prices) : null;
  })();

  // Ratings are normalised like similarity, so each signal's weight means the
  // same thing: left raw, 4.7 vs 4.9 is a 0.05 gap that any stretched signal
  // drowns out.
  const qualityScale = minMax(
    evaluated.map((e) => (bayesianRating(e.rating, e.reviews) - 1) / 4),
  );

  const weights = { ...BASE_WEIGHTS };
  weights.semantic *= semanticConfidence;
  if (intent.sortBy === "rating") weights.quality = 0.35;
  if (intent.sortBy === "price") weights.price = 0.35;
  if (intent.sortBy === "distance") weights.place = 0.45;
  if (placeMode === "bias") weights.place = 0.1;

  const scored = evaluated.map((e) => {
    const signals: Array<[number, number | undefined]> = [
      [weights.service, e.serviceScore],
      [weights.place, e.placeScore],
      [weights.semantic, semanticOf(e.c)],
      [weights.quality, qualityScale((bayesianRating(e.rating, e.reviews) - 1) / 4)],
      [
        weights.price,
        wantsCheap
          ? e.cheapest !== null && priceScale
            ? 1 - priceScale(e.cheapest)
            : 0.3
          : undefined,
      ],
    ];
    const active = signals.filter(([, value]) => value !== undefined) as Array<[number, number]>;
    const totalWeight = active.reduce((sum, [w]) => sum + w, 0);
    const base = totalWeight
      ? active.reduce((sum, [w, v]) => sum + w * v, 0) / totalWeight
      : 0;
    const score = base + (e.nameScore >= 0.6 ? 0.25 * e.nameScore : 0);

    // Partial means it meets something the customer asked for. Being in the
    // right district alone does not count - it only lifts a salon that
    // offers the service over one further away - and neither does a salon
    // that merely mentions the service, when it is somewhere else entirely.
    // A plain "near me" is the exception: the next-nearest salons, with
    // their distance, beat an empty page.
    const nearestFill =
      placeMode === "radius" &&
      requested.length === 1 &&
      e.c.distanceMeters !== null;
    const matchType: MatchType | null =
      requested.length === 0 || requested.every((r) => e.met.has(r)) || e.nameScore >= 0.6
        ? "best"
        : e.met.size > 0 ||
            (e.mentionsOnly && !requested.includes("place")) ||
            nearestFill
          ? "partial"
          : null;

    return { ...e, score, matchType: matchType as MatchType | null };
  });

  const byScore = (a: { score: number }, b: { score: number }) => b.score - a.score;
  const best = scored.filter((s) => s.matchType === "best").sort(byScore);
  const partial = scored
    .filter((s) => s.matchType === "partial")
    .sort((a, b) => b.met.size - a.met.size || byScore(a, b));

  let shown = [...best, ...partial].slice(0, limit);
  let usedAlternatives = false;
  if (shown.length === 0) {
    usedAlternatives = true;
    shown = [...scored]
      .sort(byScore)
      .slice(0, Math.min(ALTERNATIVES, limit))
      .map((s) => ({ ...s, matchType: "alternative" as const }));
  }

  // --- what could not be satisfied, said once for the whole search
  const notes: string[] = [];
  const anyService = scored.some((s) => s.met.has("service"));
  const anyPlace = scored.some((s) => s.met.has("place"));
  if (wantsService && !anyService) {
    notes.push(`No salon lists ${serviceWords} services yet.`);
  } else if (
    wantsService &&
    requested.includes("place") &&
    anyPlace &&
    !scored.some((s) => s.met.has("service") && s.met.has("place"))
  ) {
    notes.push(`No salon ${placeWords} lists ${serviceWords} services yet.`);
  } else if (requested.includes("place") && !anyPlace) {
    notes.push(
      placeMode === "radius" && origin?.source === "user"
        ? `No salons within ${radius / 1000} km of you yet.`
        : `No salons ${placeWords} yet.`,
    );
  }
  if (wantsPrice && !scored.some((s) => s.met.has("price"))) {
    notes.push(`Nothing ${priceText(intent)} is listed${wantsService ? ` for ${serviceWords}` : ""} yet.`);
  }
  if (intent.minRating !== null && !scored.some((s) => s.met.has("rating"))) {
    notes.push(`No salon is rated ${intent.minRating} stars or more yet.`);
  }
  if (intent.openNow && !scored.some((s) => s.met.has("open"))) {
    notes.push("None of them is open right now, by their listed hours.");
  }
  if (!best.length && shown.length) {
    notes.push(
      usedAlternatives ? POPULAR_INSTEAD_NOTE : CLOSEST_MATCHES_NOTE,
    );
  }

  // --- per-salon reasons, in the order the customer cares about. Typed, so
  // the page can leave out what the card already shows (stars, distance).
  const salons: RankedSalon[] = shown.map((s) => {
    const c = s.c;
    const reasons: Reason[] = [];
    const missing: Reason[] = [];
    const approximate = c.locationAccuracy === "APPROXIMATE";

    if (s.nameScore >= 0.6) {
      reasons.push({ kind: "name", text: "Matches the name you searched" });
    }

    if (wantsService) {
      const top = s.matchedServices[0];
      if (top) {
        reasons.push({ kind: "service", text: `${top.name} · ${formatBDT(top.priceMinor)}` });
      } else {
        missing.push({
          kind: "service",
          text: s.mentionsOnly
            ? "Mentions it, but lists no services yet"
            : `No ${serviceWords} listed`,
        });
      }
    }

    if (placeMode === "named") {
      const where = [c.area, c.district].filter((v) => v && v !== "N/A");
      if (s.placeMet) {
        reasons.push({ kind: "place", text: `In ${where[0] ?? intent.place!.label}` });
      } else if (s.sameDistrict) {
        reasons.push({ kind: "place", text: `In ${where.join(", ")}` });
      } else {
        missing.push({
          kind: "place",
          text: `In ${where.join(", ") || "another area"}, not ${intent.place!.label}`,
        });
      }
    }
    if (c.distanceMeters !== null && origin) {
      const d = formatDistance(c.distanceMeters, approximate);
      const text = `${d} ${origin.source === "user" ? "away" : `from ${origin.label}`}`;
      if (placeMode === "radius" && !s.placeMet) missing.push({ kind: "distance", text });
      else reasons.push({ kind: "distance", text });
    }

    // A matched service already shows its price; otherwise say what it costs.
    const showsPrice = s.matchedServices.length > 0;
    if (wantsPrice && !s.met.has("price")) {
      missing.push({
        kind: "price",
        text:
          s.cheapest !== null
            ? `From ${formatBDT(s.cheapest)}, not ${priceText(intent)}`
            : "No prices listed",
      });
    } else if ((wantsPrice || wantsCheap) && !showsPrice && s.cheapest !== null) {
      reasons.push({ kind: "price", text: `From ${formatBDT(s.cheapest)}` });
    }

    if (s.reviews > 0) {
      const text = `★ ${s.rating.toFixed(1)} (${s.reviews} review${s.reviews === 1 ? "" : "s"})`;
      if (intent.minRating !== null && !s.met.has("rating")) missing.push({ kind: "rating", text });
      else reasons.push({ kind: "rating", text });
    } else if (intent.minRating !== null) {
      missing.push({ kind: "rating", text: "No reviews yet" });
    }

    if (intent.openNow) {
      if (s.openNow === true) reasons.push({ kind: "open", text: "Open now" });
      else {
        missing.push({
          kind: "open",
          text: s.openNow === false ? "Closed now" : "Hours not listed",
        });
      }
    }

    return {
      ...c,
      distanceMeters: c.distanceMeters === null ? null : Math.round(c.distanceMeters),
      similarity: c.similarity === null ? null : Math.round(c.similarity * 1000) / 1000,
      services: s.services,
      score: Math.round(s.score * 1000) / 1000,
      matchType: s.matchType as MatchType,
      openNow: s.openNow,
      matchedServices: s.matchedServices.slice(0, 4),
      reasons: reasons.slice(0, 4),
      missing: missing.slice(0, 3),
    };
  });

  return {
    salons,
    notes,
    counts: { candidates: candidates.length, best: best.length, partial: partial.length },
  };
};
