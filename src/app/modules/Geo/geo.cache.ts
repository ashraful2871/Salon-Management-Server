import { GeoPlace } from "./providers/types";

type Entry<V> = { value: V; expiresAt: number };

/**
 * A size-capped LRU with a TTL per entry. A Map iterates in insertion order,
 * so re-inserting a key on every read moves it to the back and the first key
 * is always the least recently used one.
 *
 * Expired entries are dropped when they are next read or pushed out by the
 * size cap; with 2000 entries there is nothing worth sweeping for.
 */
export class TtlLruCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  /** `undefined` is a miss; any other value, `null` included, is a hit. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    this.entries.delete(key);
    if (entry.expiresAt <= Date.now()) return undefined;

    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });

    if (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Addresses barely move; search results change a little as OSM is edited.
export const GEO_CACHE_TTL_MS = {
  reverse: 7 * DAY_MS,
  search: DAY_MS,
} as const;

// One cache for both kinds; the key prefix keeps them apart.
export const geoCache = new TtlLruCache<GeoPlace[] | GeoPlace | null>(2000);
