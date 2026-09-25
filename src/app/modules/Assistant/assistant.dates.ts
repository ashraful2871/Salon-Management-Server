import { MAX_DAYS_AHEAD } from "./assistant.constants";
import { dhakaToday, isYmd, shiftYmd, toCalendarDate } from "./assistant.availability";

/**
 * Typed dates, resolved in code against the Dhaka clock. A model is never asked
 * to do date arithmetic: when it gets "porshu" wrong the customer turns up on
 * the wrong day, and no grounding check can catch that.
 *
 * Everything is a table plus a handful of regexes, on purpose — a parser we do
 * not own is one more thing that has to agree with how Dhaka talks.
 */

export type PartOfDay = "morning" | "afternoon" | "evening" | "night";

export type WhenReading = {
  /** "YYYY-MM-DD" in Dhaka, inside the booking window; null otherwise. */
  date: string | null;
  /** True when the text named a day at all — even one we cannot book, which
   *  is answered by asking again rather than by guessing. */
  dateMentioned: boolean;
  partOfDay: PartOfDay | null;
  /** "after 5" / "5 tar por": the earliest wall-clock time wanted. */
  after: string | null;
  /** The text with every date/time word blanked out, for the parsers after us. */
  rest: string;
};

const WEEKDAY_WORDS: Array<[number, string[]]> = [
  [0, ["sunday", "sun", "robibar", "roibar", "রবিবার", "রোববার"]],
  [1, ["monday", "mon", "sombar", "shombar", "সোমবার"]],
  [2, ["tuesday", "tue", "tues", "mongolbar", "monggolbar", "মঙ্গলবার"]],
  [3, ["wednesday", "wed", "budhbar", "budbar", "বুধবার"]],
  [4, ["thursday", "thu", "thurs", "brihospotibar", "bishudbar", "বৃহস্পতিবার"]],
  [5, ["friday", "fri", "shukrobar", "sukrobar", "শুক্রবার"]],
  [6, ["saturday", "sat", "shonibar", "sonibar", "শনিবার"]],
];

const MONTH_WORDS = [
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

/** Offsets from today. Longest phrases first so "day after tomorrow" is not
 *  read as "tomorrow". "kal" is yesterday *or* tomorrow in Bangla; in a booking
 *  chat it is always tomorrow. */
const RELATIVE: Array<[string, number]> = [
  ["day after tomorrow", 2],
  ["the day after tomorrow", 2],
  ["আগামী পরশু", 2],
  ["আগামীকাল", 1],
  ["porshu", 2],
  ["porsu", 2],
  ["পরশু", 2],
  ["tomorrow", 1],
  ["tmrw", 1],
  ["tmr", 1],
  ["kalke", 1],
  ["kalka", 1],
  ["kal", 1],
  ["কালকে", 1],
  ["কাল", 1],
  ["tonight", 0],
  ["today", 0],
  ["aajke", 0],
  ["ajke", 0],
  ["aaj", 0],
  ["aj", 0],
  ["আজকে", 0],
  ["আজ", 0],
];

const PARTS: Array<[PartOfDay, string[]]> = [
  ["morning", ["morning", "shokal", "sokal", "shokale", "sokale", "সকাল", "সকালে"]],
  ["afternoon", ["afternoon", "dupur", "dupure", "duphur", "দুপুর", "দুপুরে", "noon"]],
  [
    "evening",
    [
      "evening", "bikel", "bikele", "bikal", "bikale", "বিকাল", "বিকেল", "বিকেলে", "বিকালে",
      "shondha", "shondhay", "sondha", "sondhay", "সন্ধ্যা", "সন্ধ্যায়",
    ],
  ],
  ["night", ["tonight", "night", "rat", "rate", "raat", "raate", "রাত", "রাতে"]],
];

const BANGLA = /[ঀ-৿]/;

/** Bangla digits to ASCII and lowercase; punctuation is kept, times need it. */
export const normaliseWhen = (text: string): string =>
  text
    .normalize("NFKC")
    .replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - 0x09e6))
    .toLowerCase();

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole words for Latin; a prefix match for Bangla, whose suffixes attach
 *  ("কালকের", "বিকেলের"). */
const wordPattern = (word: string) =>
  BANGLA.test(word)
    ? new RegExp(`(?<![ঀ-৿])${escape(word)}[ঀ-৿]*`, "u")
    : new RegExp(`(?<![a-z0-9])${escape(word).replace(/\s+/g, "\\s+")}(?![a-z0-9])`);

const within = (ymd: string, today: string): boolean =>
  ymd >= today && ymd <= shiftYmd(today, MAX_DAYS_AHEAD - 1);

const blank = (text: string, match: RegExpExecArray): string =>
  text.slice(0, match.index) + " ".repeat(match[0].length) + text.slice(match.index + match[0].length);

/** 1-7 with no am/pm is afternoon or evening at a salon; 8-11 is morning. */
const hour24 = (hour: number, meridiem?: string): number => {
  if (meridiem === "am") return hour === 12 ? 0 : hour;
  if (meridiem === "pm") return hour === 12 ? 12 : hour + 12;
  return hour >= 1 && hour <= 7 ? hour + 12 : hour;
};

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Reads every date and time-of-day word out of a message. Never throws: text
 * it does not recognise simply leaves the fields null.
 */
export const readWhen = (input: string, now = new Date()): WhenReading => {
  let text = normaliseWhen(input);
  const today = dhakaToday(now);
  let date: string | null = null;
  let dateMentioned = false;
  let partOfDay: PartOfDay | null = null;
  let after: string | null = null;

  const accept = (ymd: string | null) => {
    dateMentioned = true;
    if (date === null && ymd && isYmd(ymd) && within(ymd, today)) date = ymd;
  };

  // 2026-09-26
  let m = /(?<!\d)(20\d{2})-(\d{1,2})-(\d{1,2})(?!\d)/.exec(text);
  if (m) {
    accept(`${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`);
    text = blank(text, m);
  }

  // A day and month with no year: the next time that day comes round.
  const withYear = (day: number, month: number): string | null => {
    const year = Number(today.slice(0, 4));
    for (const y of [year, year + 1]) {
      const ymd = `${y}-${pad(month)}-${pad(day)}`;
      if (isYmd(ymd) && ymd >= today) return ymd;
    }
    return null;
  };

  // 26 sep / 26th september / sep 26
  const monthAlt = MONTH_WORDS.map((w) => `${w}[a-z]*`).join("|");
  m =
    new RegExp(`(?<![a-z0-9])(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${monthAlt})(?![a-z])`).exec(text) ??
    null;
  if (m) {
    accept(withYear(Number(m[1]), MONTH_WORDS.indexOf(m[2].slice(0, 3)) + 1));
    text = blank(text, m);
  } else {
    m = new RegExp(`(?<![a-z])(${monthAlt})\\s*(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:])`).exec(text);
    if (m) {
      accept(withYear(Number(m[2]), MONTH_WORDS.indexOf(m[1].slice(0, 3)) + 1));
      text = blank(text, m);
    }
  }

  // 26/09 or 26-09 — day first, as Bangladesh writes it.
  m = /(?<![\d:])(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?(?![\d:])/.exec(text);
  if (m) {
    const [day, month] = [Number(m[1]), Number(m[2])];
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
    accept(year ? `${year}-${pad(month)}-${pad(day)}` : withYear(day, month));
    text = blank(text, m);
  }

  for (const [word, offset] of RELATIVE) {
    const match = wordPattern(word).exec(text);
    if (!match) continue;
    accept(shiftYmd(today, offset));
    if (word === "tonight") partOfDay = "night";
    text = blank(text, match);
  }

  for (const [weekday, words] of WEEKDAY_WORDS) {
    for (const word of words) {
      const next = new RegExp(`(?<![a-z])(next|ager|porer|agami)\\s+${escape(word)}(?![a-z])`).exec(text);
      const match = next ?? wordPattern(word).exec(text);
      if (!match) continue;
      const todayDow = toCalendarDate(today).getUTCDay();
      let ahead = (weekday - todayDow + 7) % 7;
      // "next friday" is never today; plain "friday" on a Friday is.
      if (next && ahead === 0) ahead = 7;
      accept(shiftYmd(today, ahead));
      text = blank(text, match);
      break;
    }
  }

  // "after 5", "5 tar por", "5 er pore", "5pm er por", "৫টার পর"
  m =
    /(?<![a-z0-9:])after\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?![a-z0-9])/.exec(text) ??
    /(?<![\d:])(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:ta|tar|tay|er|e|টা|টার|টায়)?\s*(?:por|pore|পর|পরে)(?![a-z])/.exec(text);
  if (m) {
    const hour = hour24(Number(m[1]), m[3]);
    if (hour >= 0 && hour <= 23) after = `${pad(hour)}:${m[2] ?? "00"}`;
    text = blank(text, m);
  }

  for (const [part, words] of PARTS) {
    for (const word of words) {
      const match = wordPattern(word).exec(text);
      if (!match) continue;
      partOfDay ??= part;
      text = blank(text, match);
    }
  }

  return { date, dateMentioned, partOfDay, after, rest: text.replace(/\s+/g, " ").trim() };
};

/** The date alone, or null when there is none or it cannot be booked. */
export const resolveDate = (text: string, now = new Date()): string | null =>
  readWhen(text, now).date;

/** The slot picker's band for a part of day: salons have no "night" row. */
export const bandFor = (
  part: PartOfDay | null | undefined,
): "Morning" | "Afternoon" | "Evening" | null =>
  part === "morning" ? "Morning" : part === "afternoon" ? "Afternoon" : part ? "Evening" : null;
