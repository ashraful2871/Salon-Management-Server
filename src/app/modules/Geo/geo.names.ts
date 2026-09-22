/**
 * OpenStreetMap uses the current official spellings; our division / district
 * select list (BANGLADESH_LOCATIONS on the frontend) and the salons already in
 * the database use the older ones. Keys are lowercase.
 */
export const BD_NAME_ALIASES: Record<string, string> = {
  chattogram: "Chittagong",
  barishal: "Barisal",
  cumilla: "Comilla",
  bogura: "Bogra",
  jashore: "Jessore",
};

/**
 * Maps a provider's division / district / area name onto the one our select
 * list uses: "Chattogram Division" -> "Chittagong", "Dhaka District" -> "Dhaka".
 * Anything it does not recognise comes back trimmed but otherwise untouched.
 *
 * " Metropolitan" goes too: Photon has no state_district, so its `county` is
 * the metro area ("Dhaka Metropolitan"), which is named after its district.
 */
export const normaliseBdName = (name?: string | null): string | undefined => {
  const stripped = name
    ?.trim()
    .replace(/\s+(Division|District|Metropolitan)$/i, "")
    .trim();

  if (!stripped) return undefined;

  return BD_NAME_ALIASES[stripped.toLowerCase()] ?? stripped;
};

/** The first non-blank value, trimmed. */
export const firstName = (
  ...values: (string | null | undefined)[]
): string | undefined => {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
};

/**
 * Joins the first three distinct parts into a short label. Parts are compared
 * after normalising, so "Dhaka" and "Dhaka District" count as one.
 */
export const shortLabel = (parts: (string | null | undefined)[]): string => {
  const seen = new Set<string>();
  const kept: string[] = [];

  for (const part of parts) {
    const trimmed = part?.trim();
    const key = normaliseBdName(trimmed)?.toLowerCase();
    if (!trimmed || !key || seen.has(key)) continue;

    seen.add(key);
    kept.push(trimmed);
    if (kept.length === 3) break;
  }

  return kept.join(", ");
};
