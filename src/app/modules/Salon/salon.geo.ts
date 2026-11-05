import { Prisma } from "@prisma/client";
import prisma from "../../shared/prisma";

// MUST match the expression in index "salons_geog_gist" exactly.
export const SALON_GEOG = Prisma.sql`ST_SetSRID(ST_MakePoint(s.longitude, s.latitude), 4326)::geography`;
const escapeLike = (v: string) => `%${v.replace(/[\\%_]/g, "\\$&")}%`;

/**
 * The list filters every public salon query shares: the list (both paths),
 * the map pins and the area facets, so a pin, an area count and a card always
 * agree on what "ladies parlours that do facials" means.
 */
export type SalonListFilters = {
  searchTerm?: string;
  city?: string;
  division?: string;
  district?: string;
  /** Exact and case-blind: the area facets hand out real area names. */
  area?: string;
  category?: string;
  audience?: "LADIES" | "GENTS";
  /** Only that audience's own salons, without the UNISEX ones. */
  exactAudience?: boolean;
};

type NearbyArgs = SalonListFilters & {
  lat: number;
  lng: number;
  radiusKm: number;
  page: number;
  limit: number;
  sort: "distance" | "rating" | "newest";
  status?: string;
  agentArea?: string;
};

const originOf = (a: NearbyArgs) =>
  Prisma.sql`ST_SetSRID(ST_MakePoint(${a.lng}::float8, ${a.lat}::float8), 4326)::geography`;

/** The SQL twin of the Prisma filters in SalonService.getAllSalons. */
export const filterConds = (a: SalonListFilters): Prisma.Sql[] => {
  const conds: Prisma.Sql[] = [];
  if (a.searchTerm) {
    const t = escapeLike(a.searchTerm);
    conds.push(
      Prisma.sql`(s.name ILIKE ${t} OR s.description ILIKE ${t} OR s.city ILIKE ${t} OR EXISTS (SELECT 1 FROM services sv WHERE sv."salonId" = s.id AND sv."isActive" AND NOT sv."isDeleted" AND sv.name ILIKE ${t}))`,
    );
  }
  if (a.category)
    conds.push(
      Prisma.sql`EXISTS (SELECT 1 FROM services sv WHERE sv."salonId" = s.id AND sv."isActive" AND NOT sv."isDeleted" AND sv.category = ${a.category}::"ServiceCategory")`,
    );
  if (a.audience)
    conds.push(
      a.exactAudience
        ? Prisma.sql`s.audience = ${a.audience}::"SalonAudience"`
        : Prisma.sql`s.audience IN (${a.audience}::"SalonAudience", 'UNISEX'::"SalonAudience")`,
    );
  if (a.city) conds.push(Prisma.sql`s.city ILIKE ${escapeLike(a.city)}`);
  if (a.division)
    conds.push(Prisma.sql`s.division ILIKE ${escapeLike(a.division)}`);
  if (a.district)
    conds.push(Prisma.sql`s.district ILIKE ${escapeLike(a.district)}`);
  if (a.area)
    conds.push(Prisma.sql`lower(trim(s.area)) = lower(${a.area.trim()})`);
  return conds;
};

// Shared by the page query and the empty-page count so both see the same set.
const nearbyWhere = (a: NearbyArgs) => {
  const conds: Prisma.Sql[] = [
    Prisma.sql`s."isDeleted" = false`,
    Prisma.sql`s.latitude IS NOT NULL AND s.longitude IS NOT NULL`, // matches the partial-index predicate
    Prisma.sql`ST_DWithin(${SALON_GEOG}, ${originOf(a)}, ${a.radiusKm * 1000}::float8)`,
  ];
  if (a.status) conds.push(Prisma.sql`s.status = ${a.status}::"SalonStatus"`);
  if (a.agentArea) conds.push(Prisma.sql`s.area = ${a.agentArea}`);
  conds.push(...filterConds(a));
  return Prisma.join(conds, " AND ");
};

export const findNearbySalonIds = async (a: NearbyArgs) => {
  const orderBy = {
    distance: Prisma.sql`distance_m ASC, s.id ASC`,
    rating: Prisma.sql`s.rating DESC, s."totalReviews" DESC, distance_m ASC, s.id ASC`,
    newest: Prisma.sql`s."createdAt" DESC, s.id ASC`,
  }[a.sort];

  const rows = await prisma.$queryRaw<
    { id: string; distance_m: number; total: number }[]
  >`
    SELECT s.id,
           ST_Distance(${SALON_GEOG}, ${originOf(a)})::float8 AS distance_m,
           COUNT(*) OVER ()::int AS total
    FROM salons s
    WHERE ${nearbyWhere(a)}
    ORDER BY ${orderBy}
    LIMIT ${a.limit} OFFSET ${(a.page - 1) * a.limit}`;

  return rows;
};

// Only needed when a page past the end comes back empty: the window count
// in findNearbySalonIds has no row to ride on then.
export const countNearbySalons = async (a: NearbyArgs) => {
  const [row] = await prisma.$queryRaw<{ total: number }[]>`
    SELECT COUNT(*)::int AS total
    FROM salons s
    WHERE ${nearbyWhere(a)}`;
  return row?.total ?? 0;
};

export const findSalonMarkers = async (
  minLng: number,
  minLat: number,
  maxLng: number,
  maxLat: number,
  // The nearby map shows only what the list next to it can show.
  near?: { lat: number; lng: number; radiusKm: number },
  // The list's own filters, so the pins are the salons the list would show.
  filters: SalonListFilters = {},
) => {
  const withinReach = near
    ? Prisma.sql`AND ST_DWithin(${SALON_GEOG}, ST_SetSRID(ST_MakePoint(${near.lng}::float8, ${near.lat}::float8), 4326)::geography, ${near.radiusKm * 1000}::float8)`
    : Prisma.empty;
  const conds = filterConds(filters);
  const filtered = conds.length
    ? Prisma.sql`AND ${Prisma.join(conds, " AND ")}`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<any[]>`
    SELECT s.id, s.name, s.latitude, s.longitude, s."locationAccuracy", s.rating, s."totalReviews",
           s.images[1] AS image,
           (SELECT MIN(sv."priceMinor") FROM services sv
             WHERE sv."salonId" = s.id AND sv."isDeleted" = false AND sv."isActive" = true)::int AS "minPriceMinor"
    FROM salons s
    WHERE s."isDeleted" = false AND s.status = 'ACTIVE'
      AND s.latitude  BETWEEN ${minLat}::float8 AND ${maxLat}::float8
      AND s.longitude BETWEEN ${minLng}::float8 AND ${maxLng}::float8
      ${withinReach}
      ${filtered}
    ORDER BY s.rating DESC, s."totalReviews" DESC, s.id
    LIMIT 201`;
  return { markers: rows.slice(0, 200), truncated: rows.length > 200 };
};

export type SalonArea = {
  area: string;
  district: string;
  division: string;
  count: number;
  /** The middle of its salons' pins; null when none has a pin. */
  center: { lat: number; lng: number } | null;
  /** [minLng, minLat, maxLng, maxLat] around its pins (the GET /salons/map order). */
  bbox: [number, number, number, number] | null;
};

/**
 * Every area that has a live salon matching the filters, with how many and
 * where their pins are. The location filter is built from this rather than
 * from a fixed list of places, so a new salon in a new area shows up in it
 * on its own. Areas are grouped case- and space-blind (an owner may type
 * " mirpur") and named by their most common spelling.
 */
export const findSalonAreas = async (
  filters: Pick<SalonListFilters, "audience" | "exactAudience" | "category">,
): Promise<SalonArea[]> => {
  const conds = [
    Prisma.sql`s."isDeleted" = false`,
    Prisma.sql`s.status = 'ACTIVE'`,
    Prisma.sql`trim(s.area) <> ''`,
    Prisma.sql`upper(trim(s.area)) <> 'N/A'`,
    ...filterConds(filters),
  ];
  const rows = await prisma.$queryRaw<
    {
      area: string;
      district: string;
      division: string;
      count: number;
      lat: number | null;
      lng: number | null;
      min_lat: number | null;
      min_lng: number | null;
      max_lat: number | null;
      max_lng: number | null;
    }[]
  >`
    SELECT mode() WITHIN GROUP (ORDER BY trim(s.area))     AS area,
           mode() WITHIN GROUP (ORDER BY trim(s.district)) AS district,
           mode() WITHIN GROUP (ORDER BY trim(s.division)) AS division,
           COUNT(*)::int            AS count,
           AVG(s.latitude)::float8  AS lat,
           AVG(s.longitude)::float8 AS lng,
           MIN(s.latitude)::float8  AS min_lat,
           MIN(s.longitude)::float8 AS min_lng,
           MAX(s.latitude)::float8  AS max_lat,
           MAX(s.longitude)::float8 AS max_lng
    FROM salons s
    WHERE ${Prisma.join(conds, " AND ")}
    GROUP BY lower(trim(s.area)), lower(trim(s.district))
    ORDER BY count DESC, area ASC
    LIMIT 500`;

  const round = (n: number) => Math.round(n * 1e5) / 1e5;
  return rows.map((r) => ({
    area: r.area,
    district: r.district,
    division: r.division,
    count: r.count,
    center:
      r.lat != null && r.lng != null
        ? { lat: round(r.lat), lng: round(r.lng) }
        : null,
    bbox:
      r.min_lat != null &&
      r.min_lng != null &&
      r.max_lat != null &&
      r.max_lng != null
        ? [round(r.min_lng), round(r.min_lat), round(r.max_lng), round(r.max_lat)]
        : null,
  }));
};
