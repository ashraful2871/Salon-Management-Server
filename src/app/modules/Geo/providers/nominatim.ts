import config from "../../../../config";
import { firstName, shortLabel } from "../geo.names";
import { GeocodingProvider, GeoPlace } from "./types";

type NominatimAddress = {
  suburb?: string;
  neighbourhood?: string;
  quarter?: string;
  city_district?: string;
  state_district?: string;
  county?: string;
  city?: string;
  town?: string;
  village?: string;
  state?: string;
  postcode?: string;
  country_code?: string;
};

type NominatimReverse = {
  lat?: string;
  lon?: string;
  display_name?: string;
  address?: NominatimAddress;
  error?: string; // "Unable to geocode", e.g. a point in the sea
};

/*
 * Nominatim allows at most one request per second. Every lookup takes the next
 * free slot, 1100 ms after the previous one, so a burst is spread out rather
 * than sent at once.
 *
 * The 1 req/s Nominatim queue is per process. If Render ever runs more than
 * one instance, move it to Redis or self-host Nominatim.
 */
const MIN_GAP_MS = 1100;
// Beyond this the caller has given up long before its turn comes; fail fast
// with the friendly 503 instead of letting the queue grow without bound.
const MAX_QUEUE_WAIT_MS = 8000;
let nextSlotAt = 0;

const waitForSlot = async (): Promise<void> => {
  const now = Date.now();
  const slotAt = Math.max(now, nextSlotAt);

  if (slotAt - now > MAX_QUEUE_WAIT_MS) {
    throw new Error("Nominatim queue is full");
  }

  // Reserved synchronously, so concurrent callers cannot take the same slot.
  nextSlotAt = slotAt + MIN_GAP_MS;

  if (slotAt > now) {
    await new Promise((resolve) => setTimeout(resolve, slotAt - now));
  }
};

export const nominatimProvider: Pick<GeocodingProvider, "reverse"> = {
  async reverse(lat: number, lng: number): Promise<GeoPlace | null> {
    await waitForSlot();

    const params = new URLSearchParams({
      format: "jsonv2",
      lat: String(lat),
      lon: String(lng),
      zoom: "18",
      addressdetails: "1",
      "accept-language": "en",
    });

    const response = await fetch(
      `${config.geo.nominatimUrl}/reverse?${params}`,
      {
        headers: {
          "User-Agent": config.geo.userAgent,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(5000),
      },
    );

    if (!response.ok) {
      throw new Error(`Nominatim responded ${response.status}`);
    }

    const body = (await response.json()) as NominatimReverse;
    const a = body.address;

    // The bounds box reaches into India and Myanmar; an address there is no
    // use for a salon and would fill the form with a foreign state.
    if (body.error || !a || a.country_code?.toLowerCase() !== "bd") {
      return null;
    }

    const area = firstName(
      a.suburb,
      a.neighbourhood,
      a.quarter,
      a.city_district,
    );
    const city = firstName(a.city, a.town, a.village);

    return {
      label:
        shortLabel(body.display_name?.split(",") ?? []) ||
        shortLabel([area, city, a.state]),
      lat: Number(body.lat ?? lat),
      lng: Number(body.lon ?? lng),
      area,
      district: firstName(a.state_district, a.county, a.city),
      division: firstName(a.state),
      city,
      postcode: firstName(a.postcode),
    };
  },
};
