import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import { GEO_CACHE_TTL_MS, geoCache } from "./geo.cache";
import { normaliseBdName } from "./geo.names";
import { GeoReverseQuery, GeoSearchQuery } from "./geo.validation";
import { nominatimProvider } from "./providers/nominatim";
import { photonProvider } from "./providers/photon";
import { GeocodingProvider, GeoPlace } from "./providers/types";

// Photon allows type-ahead; Nominatim does not, but is the better reverse
// geocoder. A provider that does both (Barikoi, Google) replaces this object.
const geocoder: GeocodingProvider = {
  search: photonProvider.search,
  reverse: nominatimProvider.reverse,
};

const UNAVAILABLE =
  "Address lookup is unavailable right now. You can still drag the pin.";

type CacheValue = GeoPlace[] | GeoPlace | null;

// Concurrent misses for the same key share one provider call.
const inflight = new Map<string, Promise<CacheValue>>();

/**
 * Cache -> provider -> cache. Only successful answers are stored, and "no
 * address here" (`null`) counts as one; a provider failure is never cached,
 * so the next call tries again.
 *
 * Logs name the kind of lookup only - never the caller's coordinates or query.
 */
const cached = async <T extends CacheValue>(
  kind: "search" | "reverse",
  key: string,
  load: () => Promise<T>,
): Promise<T> => {
  const hit = geoCache.get(key);
  if (hit !== undefined) {
    console.log(`[geo] ${kind} cache hit`);
    return hit as T;
  }
  console.log(`[geo] ${kind} cache miss`);

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const request = load()
    .then((value) => {
      geoCache.set(key, value, GEO_CACHE_TTL_MS[kind]);
      return value;
    })
    .catch((error: unknown) => {
      console.error(
        `[geo] ${kind} provider failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new ApiError(StatusCodes.SERVICE_UNAVAILABLE, UNAVAILABLE);
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, request);
  return request;
};

// Provider names -> the spellings in our division / district / area list.
const normalisePlace = (place: GeoPlace): GeoPlace => ({
  ...place,
  area: normaliseBdName(place.area),
  district: normaliseBdName(place.district),
  division: normaliseBdName(place.division),
  city: normaliseBdName(place.city),
});

const searchPlaces = async (query: GeoSearchQuery): Promise<GeoPlace[]> => {
  const q = query.q.trim();

  // Rounded to ~1 km: plenty for ranking, and nearby callers share an entry.
  const bias =
    query.lat !== undefined && query.lng !== undefined
      ? { lat: query.lat.toFixed(2), lng: query.lng.toFixed(2) }
      : undefined;

  const key = `search:${q.toLowerCase()}|${bias ? `${bias.lat},${bias.lng}` : ""}`;

  const places = await cached("search", key, async () =>
    (
      await geocoder.search(
        q,
        bias && { lat: Number(bias.lat), lng: Number(bias.lng) },
      )
    ).map(normalisePlace),
  );

  return places.slice(0, query.limit);
};

const reverseGeocode = async ({
  lat,
  lng,
}: GeoReverseQuery): Promise<GeoPlace> => {
  // ~11 m. The provider is asked for the rounded point, so a cached answer is
  // exactly what any caller in that cell would have got.
  const key = `reverse:${lat.toFixed(4)},${lng.toFixed(4)}`;

  const place = await cached("reverse", key, async () => {
    const found = await geocoder.reverse(
      Number(lat.toFixed(4)),
      Number(lng.toFixed(4)),
    );
    return found && normalisePlace(found);
  });

  if (!place) {
    throw new ApiError(
      StatusCodes.NOT_FOUND,
      "No address found at this spot. You can still drag the pin.",
    );
  }

  // The pin stays where the user dropped it; the address is what is near it.
  return { ...place, lat, lng };
};

export const GeoService = { searchPlaces, reverseGeocode };
