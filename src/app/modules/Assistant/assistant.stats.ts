import prisma from "../../shared/prisma";
import {
  countingSince,
  unrecordedOutcomes,
  type TurnOutcome,
} from "./assistant.log";

/**
 * `GET /assistant/stats` — the launch dashboard, in numbers only. Nothing a
 * customer typed and no transcript leaves this function: counts per day, the
 * funnel, and which non-`ok` outcomes are most common.
 *
 * Bookings are counted from `appointments.bookedVia`, not from conversations,
 * so a customer deleting their chats does not make a booking disappear from
 * the numbers.
 */

const WINDOW_DAYS = 14;
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000; // UTC+6, no daylight saving

const ymd = (date: Date) => date.toISOString().slice(0, 10);

/** Dhaka midnight, `WINDOW_DAYS - 1` days ago: today plus the thirteen before. */
const windowStart = (now: Date) => {
  const dhakaNow = new Date(now.getTime() + DHAKA_OFFSET_MS);
  const midnight = Date.UTC(
    dhakaNow.getUTCFullYear(),
    dhakaNow.getUTCMonth(),
    dhakaNow.getUTCDate() - (WINDOW_DAYS - 1),
  );
  return {
    since: new Date(midnight - DHAKA_OFFSET_MS),
    firstDay: new Date(midnight),
  };
};

type DayCount = { day: string; n: number };

const getStats = async (now = new Date()) => {
  const { since, firstDay } = windowStart(now);
  // Columns are `timestamp` holding UTC; comparing against an explicit UTC
  // timestamp keeps the session's time zone out of it.
  const sinceIso = since.toISOString();

  const [
    conversationsByDay,
    bookingsByDay,
    turnsToBook,
    recorded,
    reachedSummary,
    stoppedAt,
  ] = await Promise.all([
    prisma.$queryRaw<DayCount[]>`
      SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS n
      FROM assistant_conversations
      WHERE "createdAt" >= (${sinceIso}::timestamptz AT TIME ZONE 'UTC')
      GROUP BY 1`,
    prisma.$queryRaw<DayCount[]>`
      SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS n
      FROM appointments
      WHERE "bookedVia" = 'ASSISTANT'
        AND "createdAt" >= (${sinceIso}::timestamptz AT TIME ZONE 'UTC')
      GROUP BY 1`,
    // Taps before the booking existed, plus the tap that made it. Turns after
    // it ("my bookings", a rating) are not part of getting there.
    prisma.$queryRaw<Array<{ avg: number | null }>>`
      SELECT AVG(t.turns)::float AS avg
      FROM (
        SELECT c.id, COUNT(m.id) + 1 AS turns
        FROM assistant_conversations c
        JOIN appointments a ON a.id = c."appointmentId"
        LEFT JOIN assistant_messages m
          ON m."conversationId" = c.id AND m.role = 'USER' AND m."createdAt" < a."createdAt"
        WHERE c."createdAt" >= (${sinceIso}::timestamptz AT TIME ZONE 'UTC')
        GROUP BY c.id
      ) t`,
    prisma.$queryRaw<Array<{ outcome: TurnOutcome; n: number }>>`
      SELECT outcome, COUNT(*)::int AS n
      FROM assistant_messages
      WHERE "createdAt" >= (${sinceIso}::timestamptz AT TIME ZONE 'UTC')
        AND outcome IS NOT NULL AND outcome <> 'ok'
      GROUP BY outcome`,
    prisma.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(DISTINCT m."conversationId")::int AS n
      FROM assistant_messages m
      JOIN assistant_conversations c ON c.id = m."conversationId"
      WHERE c."createdAt" >= (${sinceIso}::timestamptz AT TIME ZONE 'UTC')
        AND m.role = 'ASSISTANT'
        AND m.blocks @> '[{"type":"booking_summary"}]'::jsonb`,
    // Where the conversations that did not book were when they went quiet.
    prisma.$queryRaw<Array<{ step: string | null; n: number }>>`
      SELECT state->>'step' AS step, COUNT(*)::int AS n
      FROM assistant_conversations
      WHERE "createdAt" >= (${sinceIso}::timestamptz AT TIME ZONE 'UTC')
        AND "appointmentId" IS NULL
      GROUP BY 1
      ORDER BY 2 DESC`,
  ]);

  const convByDay = new Map(conversationsByDay.map((r) => [r.day, r.n]));
  const bookByDay = new Map(bookingsByDay.map((r) => [r.day, r.n]));

  const daily = Array.from({ length: WINDOW_DAYS }, (_, i) => {
    const day = ymd(new Date(firstDay.getTime() + i * 24 * 60 * 60 * 1000));
    return {
      date: day,
      conversations: convByDay.get(day) ?? 0,
      bookings: bookByDay.get(day) ?? 0,
    };
  });

  const conversations = daily.reduce((sum, d) => sum + d.conversations, 0);
  const bookings = daily.reduce((sum, d) => sum + d.bookings, 0);

  // Transcript-backed outcomes cover the whole window; the ones that never
  // reach the transcript (a 429, a thrown error, the turn limit) are this
  // process's own count since it started. Both are shown, and ranked together.
  const fromDb = Object.fromEntries(recorded.map((r) => [r.outcome, r.n]));
  const sinceRestart = unrecordedOutcomes();
  const merged = new Map<string, number>();
  for (const [outcome, n] of [
    ...Object.entries(fromDb),
    ...Object.entries(sinceRestart),
  ]) {
    merged.set(outcome, (merged.get(outcome) ?? 0) + (n ?? 0));
  }
  const topProblems = [...merged.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([outcome, count]) => ({ outcome, count }));

  const avg = turnsToBook[0]?.avg;

  return {
    window: {
      days: WINDOW_DAYS,
      from: daily[0].date,
      to: daily[daily.length - 1].date,
      timeZone: "Asia/Dhaka",
    },
    daily,
    totals: { conversations, bookings },
    funnel: {
      conversations,
      reachedSummary: reachedSummary[0]?.n ?? 0,
      booked: conversations - stoppedAt.reduce((sum, r) => sum + r.n, 0),
      stoppedAt: Object.fromEntries(stoppedAt.map((r) => [r.step ?? "unknown", r.n])),
    },
    avgTurnsToBook: avg == null ? null : Math.round(avg * 10) / 10,
    topProblems,
    outcomes: {
      last14Days: fromDb,
      sinceRestart,
      countingSince: countingSince.toISOString(),
    },
  };
};

export const AssistantStats = { getStats };
