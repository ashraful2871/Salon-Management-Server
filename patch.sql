ALTER TABLE "salons"
  ADD CONSTRAINT "salons_coords_pair_chk"
    CHECK ((latitude IS NULL) = (longitude IS NULL)),
  ADD CONSTRAINT "salons_coords_range_chk"
    CHECK (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180),
  ADD CONSTRAINT "salons_location_accuracy_chk"
    CHECK ((latitude IS NULL) = ("locationAccuracy" IS NULL));

CREATE INDEX IF NOT EXISTS "salons_geog_gist" ON "salons"
  USING gist ((ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography))
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
