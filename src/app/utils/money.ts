/**
 * Money is stored as integer poisha everywhere: 1 taka = 100 poisha, so
 * BDT 150.00 is 15000. Nothing in this codebase holds money in a Float —
 * rounding error compounds through deposit splits and commission percentages
 * until the ledger no longer balances, and an unbalanced ledger is unfixable
 * after the fact.
 *
 * Columns holding poisha are named with a `Minor` suffix (`priceMinor`,
 * `amountMinor`, `depositMinor`). That suffix is load-bearing: `addTakaFields`
 * keys off it to rebuild the taka-denominated fields the API has always
 * returned, so clients keep reading `price` while the database keeps integers.
 */

/** Taka from the client (150.5) -> poisha for storage (15050). */
export const toMinor = (taka: number): number => Math.round(taka * 100);

/** Poisha from storage (15050) -> taka for display (150.5). */
export const toTaka = (minor: number): number => minor / 100;

/** Human-facing amount for emails and messages: 15000 -> "৳150". */
export const formatBDT = (minor: number): string =>
  `৳${toTaka(minor).toLocaleString("en-BD", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;

const MINOR_SUFFIX = "Minor";

/**
 * Walks a response payload and, for every `<name>Minor` integer, adds the
 * taka-denominated `<name>` next to it. This is what keeps `priceMinor` in the
 * database from becoming a breaking API change: `GET /services` still answers
 * with `price: 150`, now alongside `priceMinor: 15000`.
 *
 * Applied once in `sendResponse`, so no module formats money inline. An
 * existing `<name>` key always wins — a service that computed its own value is
 * never overwritten.
 */
export const addTakaFields = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((item) => addTakaFields(item)) as unknown as T;
  }

  // Dates, Decimals, Buffers and class instances are values, not shapes to walk.
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return value;
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(source)) {
    result[key] = addTakaFields(entry);

    if (key.endsWith(MINOR_SUFFIX) && typeof entry === "number") {
      const takaKey = key.slice(0, -MINOR_SUFFIX.length);
      if (takaKey && !(takaKey in source)) {
        result[takaKey] = toTaka(entry);
      }
    }
  }

  return result as T;
};
