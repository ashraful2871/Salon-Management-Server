/**
 * The discovery-event allow-list behind `POST /events`. Mirrored, by hand, in
 * the frontend's `src/lib/track.ts`; change both together.
 *
 * Each event takes at most a few fixed values. `dim` is "" or a
 * comma-separated list of `key:value` parts, one `event_daily` row per part;
 * `page_view` sends two ("page:home,ref:search"). Nothing free-form is
 * accepted: anything off this list is dropped and counted as `events.rejected`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type DimRule = { key: string; values: readonly string[] | "uuid" };

export const EVENT_ALLOW_LIST = {
  page_view: [
    { key: "page", values: ["home", "salons", "salon", "ai", "about", "contact", "owner", "other"] },
    { key: "ref", values: ["search", "social", "direct", "internal", "other"] },
  ],
  salon_list_viewed: [{ key: "mode", values: ["list", "map"] }],
  search_submitted: [{ key: "source", values: ["hero", "navbar", "salons_page"] }],
  salon_viewed: [{ key: "salon", values: "uuid" }],
  booking_started: [],
  slot_selected: [],
  assistant_opened: [{ key: "entry", values: ["launcher", "other"] }],
  hair_tryon_opened: [],
  signup_started: [{ key: "method", values: ["email", "google"] }],
} as const satisfies Record<string, readonly DimRule[]>;

export type EventName = keyof typeof EVENT_ALLOW_LIST;
export const EVENT_NAMES = Object.keys(EVENT_ALLOW_LIST) as EventName[];

/** The dimension a per-event total is summed over ("" when it has none). */
export const primaryKey = (event: EventName): string => {
  const rules: readonly DimRule[] = EVENT_ALLOW_LIST[event];
  return rules[0]?.key ?? "";
};

/**
 * The `event_daily` dimensions one incoming event writes, or null when it is
 * not allowed. Every rule of the event must be present exactly once.
 */
export const eventRows = (name: unknown, dim: unknown): { event: EventName; dims: string[] } | null => {
  if (typeof name !== "string" || !(name in EVENT_ALLOW_LIST)) return null;
  const event = name as EventName;
  const rules: readonly DimRule[] = EVENT_ALLOW_LIST[event];

  const raw = dim === undefined || dim === null ? "" : dim;
  if (typeof raw !== "string" || raw.length > 120) return null;
  if (!rules.length) return raw === "" ? { event, dims: [""] } : null;

  const parts = raw.split(",");
  if (parts.length !== rules.length) return null;
  const dims: string[] = [];
  for (const rule of rules) {
    const part = parts.find((p) => p.startsWith(`${rule.key}:`));
    const value = part?.slice(rule.key.length + 1) ?? "";
    const ok = rule.values === "uuid" ? UUID.test(value) : (rule.values as readonly string[]).includes(value);
    if (!ok) return null;
    dims.push(`${rule.key}:${value}`);
  }
  return { event, dims };
};

/** User agents that are never counted. */
export const BOT_UA =
  /bot|crawl|spider|slurp|scrap|headless|lighthouse|pagespeed|preview|monitor|uptime|curl|wget|python|axios|node-fetch|undici|go-http|java\/|okhttp|httpclient|phantom|selenium|puppeteer|playwright/i;
