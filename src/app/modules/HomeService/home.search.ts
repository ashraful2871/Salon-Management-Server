import { HomeCategory } from "@prisma/client";

/**
 * Text matching for the Home Service search (`?q=` on GET /catalog and
 * GET /experts, and the GET /search typeahead). Pure functions over what the
 * public reads already loaded: the pool is at most a few hundred branches
 * near one point, so ranking in memory keeps one rule for every surface and
 * needs no index or migration.
 *
 * - Case, accents and punctuation are folded; Bangla vowel signs are kept.
 * - Every word of the query must match somewhere (AND), each on its best field.
 * - A word matches a whole word, the start of a word, or (3+ letters) any part
 *   of the field with spaces removed, so "hair cut" finds "Haircut".
 * - A few spellings are one word: mehedi / mehendi / henna, brow / threading…
 * - Typos (1 edit, 2 from 8 letters) are only a fallback: when anything
 *   matches as typed, close matches are dropped (`preferExact`).
 */

export const MAX_QUERY_LENGTH = 60;
const MAX_WORDS = 6;

/** Lower-case, accents off, anything but letters/marks/digits to one space. */
export const fold = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();

// Words that say nothing on these pages: every result is a home expert.
const STOP_WORDS = new Set([
  "a", "an", "and", "the", "for", "at", "in", "of", "near", "me", "my", "to",
  "home", "service", "services", "expert", "experts", "parlour", "parlor",
]);

// Folded spellings that mean the same thing (English, Banglish, Bangla).
const SYNONYM_GROUPS: string[][] = [
  ["mehedi", "mehendi", "mehndi", "mehandi", "henna", "মেহেদি", "মেহেদী"],
  ["threading", "thread", "eyebrow", "eyebrows", "brow", "brows", "ভ্রু"],
  ["waxing", "wax"],
  ["facial", "facials", "ফেসিয়াল", "ফেসিয়াল"],
  ["makeup", "makup", "মেকআপ"],
  ["manicure", "pedicure", "mani", "pedi", "nail", "nails"],
  ["bridal", "bride", "wedding", "biye", "বিয়ে", "বিয়ে"],
  ["massage", "spa", "মাসাজ", "ম্যাসাজ"],
  ["haircut", "chulkata", "চুলকাটা"],
  ["hair", "chul", "চুল"],
  ["beard", "shave", "shaving", "dari", "daari", "দাড়ি", "দাড়ি"],
  ["grooming", "groom"],
].map((g) => [...new Set(g.map(fold))]);

const SYNONYMS = new Map<string, string[]>();
for (const group of SYNONYM_GROUPS) for (const w of group) SYNONYMS.set(w, group.filter((x) => x !== w));

/** What each category is also called, so "eyebrow" finds Threading. */
const CATEGORY_TEXT: Record<HomeCategory, string> = {
  FACIAL: "facial",
  THREADING: "threading eyebrow",
  WAXING: "waxing",
  MAKEUP: "makeup",
  MEHEDI: "mehedi henna",
  HAIR: "hair",
  MANICURE_PEDICURE: "manicure pedicure nails",
  BRIDAL: "bridal",
  MASSAGE: "massage",
  HAIRCUT: "haircut",
  BEARD: "beard",
  GROOMING: "grooming",
  OTHER: "",
};

export type HomeQuery = {
  /** As typed, trimmed and capped: echoed back and recorded. */
  raw: string;
  /** Folded, single-spaced. */
  folded: string;
  /** One entry per query word: the word first, then its synonyms. */
  words: string[][];
};

/** `?q=` → a query, or null when nothing searchable is left. */
export const parseQuery = (v: unknown): HomeQuery | null => {
  const raw = (typeof v === "string" ? v : Array.isArray(v) ? String(v[0] ?? "") : "").slice(0, MAX_QUERY_LENGTH).trim();
  const folded = fold(raw).replace(/\s+/g, " ");
  if (!folded) return null;
  const all = [...new Set(folded.split(" "))];
  const kept = all.filter((w) => !STOP_WORDS.has(w) && (w.length > 1 || /\p{N}/u.test(w)));
  if (!kept.length) return null;
  return {
    raw,
    folded,
    words: kept.slice(0, MAX_WORDS).map((w) => [w, ...(SYNONYMS.get(w) ?? [])]),
  };
};

export type Field = { text: string; words: string[]; compact: string; weight: number };

export const field = (text: string | null | undefined, weight: number): Field => {
  const f = fold(text ?? "").replace(/\s+/g, " ");
  return { text: f, words: f ? f.split(" ") : [], compact: f.replace(/ /g, ""), weight };
};

/** Fields of one service: its name, then what its category is called. */
export const offeringFields = (o: { name: string; category: HomeCategory }): Field[] => [
  field(o.name, 3),
  field(CATEGORY_TEXT[o.category], 2),
];

/** Fields of the person: name above all, then headline and salon. */
export const personFields = (p: { name: string; headline: string | null; salonName: string }): Field[] => [
  field(p.name, 4),
  field(p.headline, 1),
  field(p.salonName, 1),
];

/** Optimal string alignment distance (Levenshtein plus adjacent swaps), capped. */
const editDistance = (a: string, b: string, max: number) => {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows.push([i]);
    for (let j = 1; j <= b.length; j++) {
      if (i === 0) {
        rows[0].push(j);
        continue;
      }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, rows[i - 2][j - 2] + 1);
      rows[i].push(d);
    }
  }
  return rows[a.length][b.length];
};

type Hit = { score: number; fuzzy: boolean };

/** How well one query word (with its synonyms) matches one field: 3 word, 2 prefix, 1 inside, 0.5 typo. */
const wordHit = (variants: string[], f: Field): Hit | null => {
  if (!f.words.length) return null;
  let best = 0;
  for (const v of variants) {
    for (const w of f.words) {
      if (w === v) return { score: 3 * f.weight, fuzzy: false };
      if (best < 2 && w.startsWith(v)) best = 2;
    }
    if (best < 1 && v.length >= 3 && f.compact.includes(v)) best = 1;
  }
  if (best) return { score: best * f.weight, fuzzy: false };

  // Typos: only the word as typed, and only from 4 letters.
  const typed = variants[0];
  if (typed.length < 4) return null;
  const max = typed.length >= 8 ? 2 : 1;
  for (const w of f.words) {
    // Whole word, or (still typing, 5+ letters) the start of a longer one.
    if (editDistance(typed, w, max) <= max) return { score: 0.5 * f.weight, fuzzy: true };
    if (typed.length >= 5 && w.length > typed.length && editDistance(typed, w.slice(0, typed.length), max) <= max) {
      return { score: 0.4 * f.weight, fuzzy: true };
    }
  }
  return null;
};

/** The best hit for a word across fields. */
const bestHit = (variants: string[], fields: Field[]): Hit | null => {
  let best: Hit | null = null;
  for (const f of fields) {
    const h = wordHit(variants, f);
    if (h && (!best || h.score > best.score)) best = h;
  }
  return best;
};

/** Typed in full as the start of a field ("gold fac" → "Gold facial"): a bonus. */
const phraseBonus = (q: HomeQuery, fields: Field[]) =>
  q.words.length > 1 || q.folded.length >= 3
    ? Math.max(0, ...fields.map((f) => (f.text.startsWith(q.folded) ? 2 * f.weight : 0)))
    : 0;

export type Match = { score: number; fuzzy: boolean };

/** Every query word must hit one of `fields`. */
export const matchFields = (q: HomeQuery, fields: Field[]): Match | null => {
  let score = 0;
  let fuzzy = false;
  for (const w of q.words) {
    const h = bestHit(w, fields);
    if (!h) return null;
    score += h.score;
    fuzzy ||= h.fuzzy;
  }
  return { score: score + phraseBonus(q, fields), fuzzy };
};

export type ExpertMatch = Match & {
  /**
   * Indexes into `offerings` of the services the query was about. Empty when
   * every word matched the person (a name search): then all of them count.
   */
  matched: number[];
};

/**
 * A person with their services. Each query word may match the person or any
 * of the services: "sharmin facial" finds Sharmin when she does a facial.
 */
export const matchExpert = (q: HomeQuery, person: Field[], offerings: Field[][]): ExpertMatch | null => {
  let score = 0;
  let fuzzy = false;
  const serviceWords: string[][] = [];
  for (const w of q.words) {
    const p = bestHit(w, person);
    let o: Hit | null = null;
    for (const fields of offerings) {
      const h = bestHit(w, fields);
      if (h && (!o || h.score > o.score)) o = h;
    }
    if (!p && !o) return null;
    // A tie goes to the service: "cut" at "Gents Cut" is still about the haircut.
    const pick = p && (!o || p.score > o.score) ? p : o!;
    score += pick.score;
    fuzzy ||= pick.fuzzy;
    if (pick === o) serviceWords.push(w);
  }

  let matched: number[] = [];
  if (serviceWords.length) {
    const hits = (all: boolean) =>
      offerings.flatMap((fields, i) =>
        (all ? serviceWords.every((w) => bestHit(w, fields)) : serviceWords.some((w) => bestHit(w, fields))) ? [i] : [],
      );
    matched = hits(true);
    if (!matched.length) matched = hits(false);
  }
  return { score: score + phraseBonus(q, person), fuzzy, matched };
};

/** Close matches only when nothing matched as typed; `fuzzy` says which one this is. */
export const preferExact = <T extends { match: Match }>(items: T[]) => {
  const exact = items.filter((i) => !i.match.fuzzy);
  return exact.length ? { items: exact, fuzzy: false } : { items, fuzzy: items.length > 0 };
};
