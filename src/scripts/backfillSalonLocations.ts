/**
 * Places salons that have no coordinates at the centre of their area, or
 * failing that their district or division, and marks them APPROXIMATE so
 * nearby search finds them until the owner drags the pin to the exact spot.
 *
 *   npm run backfill:locations              dry run: prints what it would do
 *   npm run backfill:locations -- --apply   writes
 *
 * The write re-checks `latitude: null`, so a pin the owner set meanwhile is
 * never overwritten, and a second --apply changes 0 rows. Coordinates are not
 * embedded, so writing them straight through Prisma skips re-embedding.
 *
 * Centroids live in ./data/bd-area-centroids.json (see buildAreaCentroids.ts).
 */
import fs from "fs";
import path from "path";
import { normaliseBdName } from "../app/modules/Geo/geo.names";
import prisma from "../app/shared/prisma";

type LatLng = [number, number];
type Level = "area" | "district" | "division";
type Section = "divisions" | "districts" | "areas";

const CENTROIDS_FILE = path.join(__dirname, "data", "bd-area-centroids.json");

const inBangladesh = (point: unknown): point is LatLng =>
  Array.isArray(point) &&
  point.length === 2 &&
  point[0] >= 20.3 &&
  point[0] <= 26.8 &&
  point[1] >= 87.9 &&
  point[1] <= 92.8;

/**
 * Lookup key for a division / district / area name: aliased ("Chattogram" ->
 * "Chittagong"), then case, space and punctuation-blind, so "Cox’s Bazar" and
 * "coxs bazar" meet. "N/A", the column default, counts as missing.
 */
const nameKey = (name?: string | null) => {
  const normalised = normaliseBdName(name);
  if (!normalised || /^n\/?a$/i.test(normalised)) return undefined;
  return normalised.toLowerCase().replace(/[^a-z0-9]/g, "") || undefined;
};

const loadCentroids = () => {
  const file = JSON.parse(fs.readFileSync(CENTROIDS_FILE, "utf8")) as Record<
    Section,
    Record<string, unknown>
  >;

  const index = (section: Section) => {
    const map = new Map<string, LatLng>();
    for (const [name, point] of Object.entries(file[section])) {
      if (!inBangladesh(point)) {
        throw new Error(
          `${section}["${name}"] = ${JSON.stringify(point)} is not [lat, lng] in Bangladesh (swapped?)`
        );
      }
      map.set(name.split("/").map(nameKey).join("/"), point);
    }
    return map;
  };

  return {
    areas: index("areas"),
    districts: index("districts"),
    divisions: index("divisions"),
  };
};

type Centroids = ReturnType<typeof loadCentroids>;

const resolve = (
  salon: { area: string; district: string; division: string },
  centroids: Centroids
): { level: Level; point: LatLng } | undefined => {
  const area = nameKey(salon.area);
  const district = nameKey(salon.district);
  const division = nameKey(salon.division);

  const candidates: Array<[Level, LatLng | undefined]> = [
    ["area", area && district ? centroids.areas.get(`${district}/${area}`) : undefined],
    ["district", district ? centroids.districts.get(district) : undefined],
    ["division", division ? centroids.divisions.get(division) : undefined],
  ];

  const hit = candidates.find(([, point]) => point);
  return hit && { level: hit[0], point: hit[1]! };
};

const clip = (text: string, max = 32) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const printTable = (rows: string[][]) => {
  const widths = rows[0].map((_, col) =>
    Math.max(...rows.map((row) => row[col].length))
  );
  rows.forEach((row, i) => {
    console.log(row.map((cell, col) => cell.padEnd(widths[col])).join(" | "));
    if (i === 0) console.log(widths.map((w) => "-".repeat(w)).join("-|-"));
  });
};

const main = async () => {
  const apply = process.argv.includes("--apply");
  const centroids = loadCentroids();

  const salons = await prisma.salon.findMany({
    where: { latitude: null, isDeleted: false },
    select: {
      id: true,
      name: true,
      area: true,
      district: true,
      division: true,
      city: true,
    },
    orderBy: { name: "asc" },
  });

  console.log(
    apply
      ? `Placing ${salons.length} salon(s) that have no coordinates...\n`
      : `Dry run (pass --apply to write): ${salons.length} salon(s) have no coordinates.\n`
  );

  type Salon = (typeof salons)[number];
  const matched: Array<{ salon: Salon; level: Level; point: LatLng }> = [];
  const unmatched: Salon[] = [];
  for (const salon of salons) {
    const match = resolve(salon, centroids);
    if (match) matched.push({ salon, ...match });
    else unmatched.push(salon);
  }

  if (matched.length) {
    printTable([
      ["name", "area", "district", "matched level", "lat,lng"],
      ...matched.map(({ salon, level, point }) => [
        clip(salon.name),
        salon.area,
        salon.district,
        level,
        point.join(","),
      ]),
    ]);

    const byLevel = (level: Level) => matched.filter((m) => m.level === level).length;
    console.log(
      `\nMatched ${matched.length}: ${byLevel("area")} by area, ` +
        `${byLevel("district")} by district, ${byLevel("division")} by division.`
    );
  }

  if (unmatched.length) {
    console.log(`\nUnmatched ${unmatched.length} (fix by hand, then re-run):`);
    unmatched.forEach((s) =>
      console.log(
        `  ${s.name} (${s.id}): area "${s.area}", district "${s.district}", ` +
          `division "${s.division}", city "${s.city}"`
      )
    );
  }

  if (apply) {
    let updated = 0;
    for (const { salon, point } of matched) {
      const { count } = await prisma.salon.updateMany({
        where: { id: salon.id, latitude: null },
        data: {
          latitude: point[0],
          longitude: point[1],
          locationAccuracy: "APPROXIMATE",
          locationUpdatedAt: new Date(),
        },
      });
      updated += count;
    }

    console.log(
      `\nDone: ${updated} row(s) changed` +
        (matched.length > updated
          ? `, ${matched.length - updated} skipped (pinned meanwhile).`
          : ".")
    );
  }

  await prisma.$disconnect();
};

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
