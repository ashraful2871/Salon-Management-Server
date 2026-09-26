import { Prisma } from "@prisma/client";
import prisma from "../../shared/prisma";

// MUST match the expression in index "salons_geog_gist" exactly.
export const SALON_GEOG = Prisma.sql`ST_SetSRID(ST_MakePoint(s.longitude, s.latitude), 4326)::geography`;
const escapeLike = (v: string) => `%${v.replace(/[\\%_]/g, "\\$&")}%`;

type NearbyArgs = {
  lat: number;
  lng: number;
  radiusKm: number;
  page: number;
  limit: number;
  sort: "distance" | "rating" | "newest";
  status?: string;
  agentArea?: string;
  searchTerm?: string;
  city?: string;
  division?: string;
  district?: string;
  area?: string;
};

const originOf = (a: NearbyArgs) =>
  Prisma.sql`ST_SetSRID(ST_MakePoint(${a.lng}::float8, ${a.lat}::float8), 4326)::geography`;

// Shared by the page query and the empty-page count so both see the same set.
const nearbyWhere = (a: NearbyArgs) => {
  const conds: Prisma.Sql[] = [
    Prisma.sql`s."isDeleted" = false`,
    Prisma.sql`s.latitude IS NOT NULL AND s.longitude IS NOT NULL`, // matches the partial-index predicate
    Prisma.sql`ST_DWithin(${SALON_GEOG}, ${originOf(a)}, ${a.radiusKm * 1000}::float8)`,
  ];
  if (a.status) conds.push(Prisma.sql`s.status = ${a.status}::"SalonStatus"`);
  if (a.agentArea) conds.push(Prisma.sql`s.area = ${a.agentArea}`);
  if (a.searchTerm) {
    const t = escapeLike(a.searchTerm);
    conds.push(
      Prisma.sql`(s.name ILIKE ${t} OR s.description ILIKE ${t} OR s.city ILIKE ${t})`,
    );
  }
  if (a.city) conds.push(Prisma.sql`s.city ILIKE ${escapeLike(a.city)}`);
  if (a.division)
    conds.push(Prisma.sql`s.division ILIKE ${escapeLike(a.division)}`);
  if (a.district)
    conds.push(Prisma.sql`s.district ILIKE ${escapeLike(a.district)}`);
  if (a.area) conds.push(Prisma.sql`s.area ILIKE ${escapeLike(a.area)}`);
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
) => {
  const withinReach = near
    ? Prisma.sql`AND ST_DWithin(${SALON_GEOG}, ST_SetSRID(ST_MakePoint(${near.lng}::float8, ${near.lat}::float8), 4326)::geography, ${near.radiusKm * 1000}::float8)`
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
    ORDER BY s.rating DESC, s."totalReviews" DESC, s.id
    LIMIT 201`;
  return { markers: rows.slice(0, 200), truncated: rows.length > 200 };
};
