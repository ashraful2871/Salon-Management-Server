import { formatBDT } from "../../utils/money";

/**
 * Referral discount and eligibility maths. Pure: no Prisma, no database, no
 * settings reads - callers pass the reward's snapshot and the booking's
 * figures in, so the same answer comes out of a quote, the booking
 * transaction, the assistant and the check script (`npm run referral:math`).
 * Frontend `lib/referral.ts` mirrors this file for previews only.
 *
 * Money is integer poisha. A discount is floored to whole taka.
 */

export type Scope = "ALL" | "SALON" | "HOME";
export type BookingKind = "SALON" | "HOME";

/** The terms a reward was issued with (its snapshot columns). */
export type RewardTerms = {
  id: string;
  kind: string;
  percentBps: number;
  maxDiscountMinor: number;
  minOrderMinor: number;
  scope: Scope;
  firstBookingOnly: boolean;
  expiresAt: Date;
};

/**
 * What the reward is being tried against. `baseMinor` is `Appointment.totalMinor`
 * for a salon booking and `HomeBooking.subtotalMinor` for a home visit (services
 * only, never the travel fee). `completedBookings` counts the customer's
 * COMPLETED appointments + home visits.
 */
export type ApplyCtx = {
  kind: BookingKind;
  baseMinor: number;
  completedBookings: number;
  now: Date;
};

export type NotApplicable = "EXPIRED" | "SCOPE" | "MIN_ORDER" | "FIRST_BOOKING_DONE" | "TOO_SMALL";

export type Applied = { reward: RewardTerms; discountMinor: number };

/** Below this (৳1) a discount is not worth applying. */
const MIN_DISCOUNT_MINOR = 100;

/**
 * `min( floor_to_taka(base × bps / 10 000), cap || ∞, base )`, and 0 when that
 * is under ৳1. A cap of 0 means no cap.
 */
export const rewardDiscountMinor = (
  baseMinor: number,
  percentBps: number,
  maxDiscountMinor: number,
): number => {
  if (!Number.isFinite(baseMinor) || !Number.isFinite(percentBps) || baseMinor <= 0 || percentBps <= 0) {
    return 0;
  }
  const base = Math.floor(baseMinor);
  let d = Math.floor((base * Math.floor(percentBps)) / 1_000_000) * 100;
  if (maxDiscountMinor > 0) d = Math.min(d, Math.floor(maxDiscountMinor));
  d = Math.min(d, base);
  return d < MIN_DISCOUNT_MINOR ? 0 : d;
};

/**
 * Can this reward be used on this booking, and for how much? Checked in this
 * order: lasting reasons first (expired, first booking already done), then the
 * ones this particular booking could change (scope, minimum, size).
 *
 * A reward is valid while `now < expiresAt` (the reserve guard is
 * `expiresAt > now`). This decides new quotes and reservations only; a
 * reservation already made is honoured whatever this says later.
 */
export const applicability = (
  r: RewardTerms,
  ctx: ApplyCtx,
): { ok: true; discountMinor: number } | { ok: false; reason: NotApplicable } => {
  if (!(r.expiresAt.getTime() > ctx.now.getTime())) return { ok: false, reason: "EXPIRED" };
  if (r.firstBookingOnly && ctx.completedBookings > 0) return { ok: false, reason: "FIRST_BOOKING_DONE" };
  if (r.scope !== "ALL" && r.scope !== ctx.kind) return { ok: false, reason: "SCOPE" };
  if (r.minOrderMinor > 0 && ctx.baseMinor < r.minOrderMinor) return { ok: false, reason: "MIN_ORDER" };
  const discountMinor = rewardDiscountMinor(ctx.baseMinor, r.percentBps, r.maxDiscountMinor);
  if (discountMinor === 0) return { ok: false, reason: "TOO_SMALL" };
  return { ok: true, discountMinor };
};

/**
 * The reward to apply automatically: the largest discount for this booking,
 * ties to the earliest expiry (then the id, so the pick is stable). `options`
 * is every applicable reward in that order - the customer may pick another or
 * none; `notApplicable` says why the rest were left out.
 */
export const pickBest = (
  rewards: RewardTerms[],
  ctx: ApplyCtx,
): {
  best: Applied | null;
  options: Applied[];
  notApplicable: { reward: RewardTerms; reason: NotApplicable }[];
} => {
  const options: Applied[] = [];
  const notApplicable: { reward: RewardTerms; reason: NotApplicable }[] = [];
  for (const reward of rewards) {
    const a = applicability(reward, ctx);
    if (a.ok) options.push({ reward, discountMinor: a.discountMinor });
    else notApplicable.push({ reward, reason: a.reason });
  }
  options.sort(
    (a, b) =>
      b.discountMinor - a.discountMinor ||
      a.reward.expiresAt.getTime() - b.reward.expiresAt.getTime() ||
      (a.reward.id < b.reward.id ? -1 : a.reward.id > b.reward.id ? 1 : 0),
  );
  return { best: options[0] ?? null, options, notApplicable };
};

/* ---------------------------------------------------------------- codes */

/** 32 characters: no 0/O and no 1/I, so random padding can't be misread. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const CODE_SHAPE = /^[A-Z2-9]{6,12}$/;

/**
 * A typed or linked code as it is stored, or null when it can't be one. Trims,
 * drops spaces and dashes (including the long dashes phones auto-correct to),
 * upper-cases, and reads a zero as the letter O - no code contains 0, but a
 * name prefix can contain O.
 */
export const normalizeCode = (raw: string): string | null => {
  if (typeof raw !== "string") return null;
  const code = raw
    .trim()
    .replace(/[\s\-‐-―]+/g, "")
    .toUpperCase()
    .replace(/0/g, "O");
  return CODE_SHAPE.test(code) ? code : null;
};

/** Abbreviations that lead many Bangladeshi names; the prefix skips them. */
const NAME_TITLES = new Set(["MD", "MOHD", "MST", "MOST", "MR", "MRS", "MS", "DR", "SK"]);

const latinLetters = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");

/**
 * Up to 5 letters A-Z from the first name, diacritics stripped ("Zoë" → "ZOE"),
 * skipping a leading title ("Md. Ashraful" → "ASHRA"); "" when the first name
 * has no Latin letters (e.g. written in Bangla). The code is padded from
 * `CODE_ALPHABET` to its full length.
 */
export const codePrefix = (name: string): string => {
  const words = (name ?? "").trim().split(/\s+/).map(latinLetters).filter(Boolean);
  while (words.length > 1 && NAME_TITLES.has(words[0])) words.shift();
  return (words[0] ?? "").slice(0, 5);
};

/* ------------------------------------------------------------ identity */

/**
 * An email as the self-referral check compares it: lower case, and for Gmail
 * (gmail.com / googlemail.com, which deliver to the same inbox) without dots
 * or a `+tag` in the local part.
 */
export const normalizeEmailForSelfCheck = (email: string): string => {
  const e = (email ?? "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0) return e;
  const domain = e.slice(at + 1);
  if (domain !== "gmail.com" && domain !== "googlemail.com") return e;
  const local = e.slice(0, at).split("+")[0].replace(/\./g, "");
  return `${local}@gmail.com`;
};

/**
 * A Bangladeshi mobile number as `01XXXXXXXXX`, or null. Digits only, a
 * leading 88 (from +880 / 880) dropped; operators 013-019. Same rule as the
 * SQL in `npm run referral:check`.
 */
export const bdPhone = (raw?: string | null): string | null => {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, "");
  if (/^8801\d{9}$/.test(d)) d = d.slice(2);
  return /^01[3-9]\d{8}$/.test(d) ? d : null;
};

/* ------------------------------------------------------------- display */

export const percentToBps = (p: number) => Math.round(p * 100);

/** 500 → "5", 550 → "5.5", 1234 → "12.34". */
const percentText = (percent: number) => String(Math.round(percent * 100) / 100);

export const rewardLabel = (kind: string, percentBps: number): string => {
  const p = `${percentText(percentBps / 100)}%`;
  if (kind === "REFEREE_WELCOME") return `Welcome reward (${p})`;
  if (kind === "REFERRER_BONUS") return `Referral reward (${p})`;
  return `Reward (${p})`;
};

const nameWords = (name: string) => {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && NAME_TITLES.has(latinLetters(words[0]))) words.shift();
  return words;
};

/** The first word of a name, skipping a leading title ("Md. Rahim Khan" → "Rahim"). */
export const firstNameOf = (name: string): string => nameWords(name)[0] ?? "";

/**
 * How one customer is shown to another: first name and the last name's
 * initial ("Rahim Khan" → "Rahim K.", "Rahim" → "Rahim"). Never an email or
 * phone.
 */
export const friendName = (name: string): string => {
  const words = nameWords(name);
  if (words.length === 0) return "A friend";
  if (words.length === 1) return words[0];
  return `${words[0]} ${Array.from(words[words.length - 1])[0].toUpperCase()}.`;
};

/** 00:00 on the 1st of the current month in Asia/Dhaka (UTC+6, no DST), as a UTC instant. */
export const monthStartDhaka = (now: Date): Date => {
  const d = new Date(now.getTime() + 6 * 60 * 60 * 1000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 6 * 60 * 60 * 1000);
};

/**
 * The share text with its placeholders filled: {percent} {code} {link} {site}
 * {cap}. A cap of 0 reads "no limit". Unknown placeholders are left as typed.
 */
export const fillShareMessage = (
  tpl: string,
  v: { percent: number; code: string; link: string; site: string; capMinor: number },
): string => {
  const values: Record<string, string> = {
    percent: percentText(v.percent),
    code: v.code,
    link: v.link,
    site: v.site,
    cap: v.capMinor > 0 ? formatBDT(v.capMinor) : "no limit",
  };
  return tpl.replace(/\{(percent|code|link|site|cap)\}/g, (_, k: string) => values[k]);
};
