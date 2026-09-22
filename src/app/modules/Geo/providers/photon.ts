import config from "../../../../config";
import { BD_BOUNDS } from "../../Salon/salon.validation";
import { firstName, shortLabel } from "../geo.names";
import { GeoBias, GeocodingProvider, GeoPlace } from "./types";

type PhotonProperties = {
  name?: string;
  type?: string; // house | street | locality | district | city | county | state | ...
  street?: string;
  locality?: string;
  district?: string;
  city?: string;
  county?: string;
  state?: string;
  postcode?: string;
  countrycode?: string;
};

type PhotonFeature = {
  geometry?: { coordinates?: number[] };
  properties?: PhotonProperties;
};

type PhotonResponse = { features?: PhotonFeature[] };

// Photon's bbox is minLon,minLat,maxLon,maxLat.
const BD_BBOX = [
  BD_BOUNDS.minLng,
  BD_BOUNDS.minLat,
  BD_BOUNDS.maxLng,
  BD_BOUNDS.maxLat,
].join(",");

// Always ask for more than the largest `limit` we serve: the box also covers
// West Bengal, Assam, Tripura and Myanmar, and those hits are filtered out
// below. A fixed size also lets one cache entry answer every `limit`.
const FETCH_LIMIT = 15;

const toGeoPlace = (feature: PhotonFeature): GeoPlace | null => {
  const p = feature.properties ?? {};
  const [lng, lat] = feature.geometry?.coordinates ?? [];

  if (typeof lat !== "number" || typeof lng !== "number") return null;

  // A feature that *is* a suburb or a city carries its own name in `name`,
  // not in the parent field, so it has to be picked up by type.
  const own = (...types: string[]) =>
    p.type && types.includes(p.type) ? p.name : undefined;

  return {
    label: shortLabel([
      p.name,
      p.street,
      p.locality,
      p.district,
      p.city,
      p.county,
      p.state,
    ]),
    lat,
    lng,
    area: firstName(own("district", "locality"), p.district, p.locality),
    district: firstName(own("county"), p.county, own("city"), p.city),
    division: firstName(own("state"), p.state),
    city: firstName(own("city"), p.city),
    postcode: firstName(p.postcode),
  };
};

export const photonProvider: Pick<GeocodingProvider, "search"> = {
  async search(q: string, bias?: GeoBias): Promise<GeoPlace[]> {
    const params = new URLSearchParams({
      q,
      limit: String(FETCH_LIMIT),
      lang: "en",
      bbox: BD_BBOX,
    });
    if (bias) {
      params.set("lat", String(bias.lat));
      params.set("lon", String(bias.lng));
    }

    const response = await fetch(`${config.geo.photonUrl}/api/?${params}`, {
      headers: {
        "User-Agent": config.geo.userAgent,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Photon responded ${response.status}`);
    }

    const body = (await response.json()) as PhotonResponse;
    const seen = new Set<string>();
    const places: GeoPlace[] = [];

    for (const feature of body.features ?? []) {
      if (feature.properties?.countrycode?.toUpperCase() !== "BD") continue;

      const place = toGeoPlace(feature);
      // OSM often has the same place as a node and a way; show it once.
      if (!place || !place.label || seen.has(place.label)) continue;

      seen.add(place.label);
      places.push(place);
    }

    return places;
  },
};
