/**
 * One-off: builds src/scripts/data/bd-area-centroids.json, the table
 * backfillSalonLocations.ts places existing salons with.
 *
 *   npx ts-node-dev --transpile-only ./src/scripts/buildAreaCentroids.ts
 *
 * Divisions and districts come from nuhil/bangladesh-geocode (MIT). It has no
 * division coordinates, so a division uses its headquarters district's point
 * (each division is named after its headquarters). Areas come from one
 * Nominatim search each, 1.1 s apart, as its usage policy asks.
 *
 * Check every area point on a map before committing the file: the script
 * prints an OpenStreetMap link for each one. Never feed it Google coordinates.
 */
import fs from "fs";
import path from "path";
import config from "../config";
import {
  BD_NAME_ALIASES,
  normaliseBdName,
} from "../app/modules/Geo/geo.names";

type LatLng = [number, number];

type NominatimHit = {
  lat: string;
  lon: string;
  display_name: string;
  addresstype?: string;
  type?: string;
};

// Copy of BANGLADESH_LOCATIONS (Salon-Management-Frontend/src/constants/
// bangladesh-locations.ts), district -> areas: the two repos share no code.
const AREAS: Record<string, string[]> = {
  Dhaka: ["Mirpur", "Dhanmondi", "Gulshan", "Banani", "Uttara", "Mohammadpur", "Badda"],
  Gazipur: ["Tongi", "Sripur", "Kaliakair", "Kapasia"],
  Narayanganj: ["Fatullah", "Siddhirganj", "Rupganj", "Araihazar"],
  Chittagong: ["Agrabad", "Halishahar", "Pahartali", "Kotwali", "Khulshi"],
  "Cox's Bazar": ["Ukhia", "Teknaf", "Ramu", "Moheshkhali"],
  Sylhet: ["Kotwali", "Jalalabad", "Dakshin Surma", "Airport"],
  Moulvibazar: ["Sreemangal", "Kulaura", "Rajnagar", "Kamalganj"],
  Rajshahi: ["Boalia", "Motihar", "Rajpara", "Shah Mokhdum"],
  Bogra: ["Shibganj", "Kahaloo", "Nandigram", "Dhunat"],
  Khulna: ["Khalishpur", "Daulatpur", "Sonadanga", "Batiaghata"],
  Barisal: ["Kotwali", "Babuganj", "Bakerganj", "Wazirpur"],
};

// "<district>/<area>" -> the query to send instead, found by reviewing a run.
// null skips an area OSM has no point for; salons there fall back to the
// district point, which for these city thanas is the city centre anyway.
const QUERY_OVERRIDES: Record<string, string | null> = {
  "Gazipur/Sripur": "Sreepur, Gazipur, Bangladesh",
  "Chittagong/Pahartali": "Pahartali Thana, Chattogram", // else a Raozan highway
  "Rajshahi/Boalia": "Boalia Thana, Rajshahi", // else a road in Chapai Nawabganj
  "Moulvibazar/Sreemangal": "Srimangal, Moulvibazar", // else a flour mill
  "Sylhet/Jalalabad": null, // Nominatim reads it as Sylhet's old name
  "Sylhet/Kotwali": null,
  "Rajshahi/Rajpara": null,
  "Barisal/Kotwali": null,
};

const NUHIL = "https://raw.githubusercontent.com/nuhil/bangladesh-geocode/master";
const OUT_FILE = path.join(__dirname, "data", "bd-area-centroids.json");
const SOURCE =
  "Divisions and districts: nuhil/bangladesh-geocode (MIT); a division uses its headquarters district's point. " +
  "Areas: © OpenStreetMap contributors (ODbL), via Nominatim, hand-reviewed.";
const PLACEHOLDER_CONTACT = "you@yourdomain.com";
const REQUEST_GAP_MS = 1100;
const FAR_FROM_DISTRICT_KM = 50;

// nuhil spellings the alias map does not cover.
const NUHIL_FIXUPS: Record<string, string> = {
  Chattagram: "Chittagong",
  Coxsbazar: "Cox's Bazar",
};

// Our spelling -> OSM's current one ("Chittagong" -> "Chattogram"), tried
// when Nominatim finds nothing under ours.
const OSM_SPELLING: Record<string, string> = Object.fromEntries(
  Object.entries(BD_NAME_ALIASES).map(([osm, ours]) => [
    ours,
    osm[0].toUpperCase() + osm.slice(1),
  ])
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const round = (n: number) => Math.round(n * 1e5) / 1e5;

const inBangladesh = ([lat, lng]: LatLng) =>
  lat >= 20.3 && lat <= 26.8 && lng >= 87.9 && lng <= 92.8;

const distanceKm = ([aLat, aLng]: LatLng, [bLat, bLng]: LatLng) => {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * rad) / 2) ** 2 +
    Math.cos(aLat * rad) *
      Math.cos(bLat * rad) *
      Math.sin(((bLng - aLng) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

const osmLink = ([lat, lng]: LatLng) =>
  `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`;

/** nuhil's files are phpMyAdmin exports: the rows sit in the "table" entry. */
const fetchNuhilTable = async (file: string) => {
  const res = await fetch(`${NUHIL}/${file}`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);

  const dump = (await res.json()) as Array<{
    type: string;
    data?: Record<string, string>[];
  }>;
  const table = dump.find((part) => part.type === "table")?.data;
  if (!table) throw new Error(`${file}: no table in the export`);
  return table;
};

const nuhilName = (name: string) =>
  NUHIL_FIXUPS[name] ?? normaliseBdName(name) ?? name;

let lastRequestAt = 0;

const nominatimSearch = async (q: string) => {
  const wait = lastRequestAt + REQUEST_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  const params = new URLSearchParams({
    q,
    format: "jsonv2",
    limit: "1",
    countrycodes: "bd",
    "accept-language": "en",
  });
  const res = await fetch(`${config.geo.nominatimUrl}/search?${params}`, {
    headers: { "User-Agent": config.geo.userAgent, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status} for "${q}"`);

  const [hit] = (await res.json()) as NominatimHit[];
  return hit;
};

const section = (entries: Record<string, LatLng>) =>
  "{\n" +
  Object.entries(entries)
    .map(([name, [lat, lng]]) => `    ${JSON.stringify(name)}: [${lat}, ${lng}]`)
    .join(",\n") +
  "\n  }";

const main = async () => {
  if (config.geo.userAgent.includes(PLACEHOLDER_CONTACT)) {
    console.error(
      "GEOCODER_USER_AGENT is unset: Nominatim's usage policy requires a User-Agent with a real contact."
    );
    process.exit(1);
  }

  const [divisionRows, districtRows] = await Promise.all([
    fetchNuhilTable("divisions/divisions.json"),
    fetchNuhilTable("districts/districts.json"),
  ]);

  const districts: Record<string, LatLng> = {};
  for (const row of [...districtRows].sort((a, b) =>
    nuhilName(a.name).localeCompare(nuhilName(b.name))
  )) {
    const point: LatLng = [round(Number(row.lat)), round(Number(row.lon))];
    if (!inBangladesh(point)) {
      throw new Error(`District ${row.name}: [${point}] is outside Bangladesh`);
    }
    districts[nuhilName(row.name)] = point;
  }
  if (Object.keys(districts).length !== 64) {
    throw new Error(`Expected 64 districts, got ${Object.keys(districts).length}`);
  }

  const divisions: Record<string, LatLng> = {};
  for (const row of divisionRows) {
    const name = nuhilName(row.name);
    if (!districts[name]) throw new Error(`Division ${name}: no district of that name`);
    divisions[name] = districts[name];
  }

  const missingDistricts = Object.keys(AREAS).filter((d) => !districts[d]);
  if (missingDistricts.length) {
    throw new Error(`Not in nuhil's districts: ${missingDistricts.join(", ")}`);
  }

  const areas: Record<string, LatLng> = {};
  const notFound: string[] = [];
  const skipped: string[] = [];

  for (const [district, names] of Object.entries(AREAS)) {
    for (const area of names) {
      const key = `${district}/${area}`;
      const override = QUERY_OVERRIDES[key];
      if (override === null) {
        skipped.push(key);
        continue;
      }

      const queries = override
        ? [override]
        : [
            `${area}, ${district}, Bangladesh`,
            ...(OSM_SPELLING[district]
              ? [`${area}, ${OSM_SPELLING[district]}, Bangladesh`]
              : []),
          ];

      let found: { point: LatLng; hit: NominatimHit; query: string } | undefined;
      for (const query of queries) {
        const hit = await nominatimSearch(query);
        const point: LatLng | undefined = hit && [
          round(Number(hit.lat)),
          round(Number(hit.lon)),
        ];
        if (point && inBangladesh(point)) {
          found = { point, hit, query };
          break;
        }
      }

      if (!found) {
        notFound.push(key);
        console.log(`${key} → NOT FOUND (tried: ${queries.join(" | ")})`);
        continue;
      }

      const { point, hit, query } = found;
      const km = distanceKm(point, districts[district]);
      const flags = [
        query !== queries[0] && `matched on "${query}"`,
        km > FAR_FROM_DISTRICT_KM && `${Math.round(km)} km from the district point`,
      ].filter(Boolean);

      areas[key] = point;
      console.log(`${key} → ${point.join(",")} → ${osmLink(point)}`);
      console.log(
        `    ${hit.display_name} (${hit.addresstype ?? hit.type}), ${km.toFixed(1)} km from district point` +
          (flags.length ? `  ⚠ ${flags.join("; ")}` : "")
      );
    }
  }

  const json =
    `{\n  "_source": ${JSON.stringify(SOURCE)},\n` +
    `  "divisions": ${section(divisions)},\n` +
    `  "districts": ${section(districts)},\n` +
    `  "areas": ${section(areas)}\n}\n`;
  JSON.parse(json);

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, json);

  console.log(
    `\nWrote ${OUT_FILE}: ${Object.keys(divisions).length} divisions, ` +
      `${Object.keys(districts).length} districts, ${Object.keys(areas).length} areas.`
  );
  if (skipped.length) {
    console.log(`Skipped by override (district point instead): ${skipped.join(", ")}`);
  }
  if (notFound.length) {
    console.log(
      `Not found (salons there fall back to the district point): ${notFound.join(", ")}`
    );
  }
  console.log("Review every area link above on the map before committing the file.");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
