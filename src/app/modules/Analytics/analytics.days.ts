import { Prisma } from "@prisma/client";

/**
 * Every analytics day is an Asia/Dhaka calendar date, written "YYYY-MM-DD".
 * Dhaka is UTC+6 all year (no daylight saving), so the arithmetic is exact.
 * Columns are `timestamp` holding UTC, hence `(col AT TIME ZONE 'UTC') AT TIME
 * ZONE 'Asia/Dhaka'` in SQL; the same expression `assistant.stats.ts` uses.
 */

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** The Dhaka date containing `at`. */
export const dhakaDay = (at = new Date()) =>
  new Date(at.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10);

/** The UTC instant at which Dhaka day `day` begins. */
export const dayStart = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - DHAKA_OFFSET_MS);

export const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Inclusive list of days from `from` to `to`. */
export const daysBetween = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

/** A `@db.Date` value: the calendar date at UTC midnight. */
export const dateOnly = (day: string) => new Date(`${day}T00:00:00Z`);

export const isDay = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** SQL: the Dhaka "YYYY-MM-DD" of a UTC timestamp expression. */
export const daySql = (col: string) =>
  Prisma.raw(`to_char((${col} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD')`);

/** SQL: a JS instant as a UTC `timestamp`, comparable with the columns. */
export const utcTs = (at: Date) => Prisma.sql`(${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/** SQL: `col` within [from, to). */
export const between = (col: string, from: Date, to: Date) =>
  Prisma.sql`${Prisma.raw(col)} >= ${utcTs(from)} AND ${Prisma.raw(col)} < ${utcTs(to)}`;
