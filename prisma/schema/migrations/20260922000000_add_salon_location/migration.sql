-- Salon location for "near me" (location_plan.md). Written by hand.
-- PostGIS needs no Prisma type: we keep plain lat/lng columns and index an expression over them.
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TYPE "LocationAccuracy" AS ENUM ('EXACT', 'APPROXIMATE');

ALTER TABLE "salons"
  ADD COLUMN "latitude"          DOUBLE PRECISION,
  ADD COLUMN "longitude"         DOUBLE PRECISION,
  ADD COLUMN "locationAccuracy"  "LocationAccuracy",
  ADD COLUMN "locationUpdatedAt" TIMESTAMP(3);

-- Prisma ignores CHECK constraints, so future diffs leave them alone.
ALTER TABLE "salons"
  ADD CONSTRAINT "salons_coords_pair_chk"
    CHECK ((latitude IS NULL) = (longitude IS NULL)),
  ADD CONSTRAINT "salons_coords_range_chk"
    CHECK (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180),
  ADD CONSTRAINT "salons_location_accuracy_chk"
    CHECK ((latitude IS NULL) = ("locationAccuracy" IS NULL));

CREATE INDEX IF NOT EXISTS "salons_latitude_longitude_idx" ON "salons" ("latitude", "longitude");

-- Spatial index. Partial + expression: Prisma 6 cannot see it, so `migrate dev` will not drop it
-- (re-check this after upgrading to Prisma >= 7.4). Queries MUST use the identical expression (SALON_GEOG).
CREATE INDEX IF NOT EXISTS "salons_geog_gist" ON "salons"
  USING gist ((ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography))
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
