import { createHmac, createHash, randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
import config from "../../../config";
import prisma from "../../shared/prisma";
import { incrementMetrics } from "./analytics.capture";
import { dhakaDay } from "./analytics.days";
import { BOT_UA, eventRows } from "./analytics.events";

/**
 * `POST /events`: cookieless discovery counts. What is kept is a per-day count
 * per allow-listed (event, dimension), and one hash per visitor per day:
 * sha256(dailySalt ‖ clientIp ‖ userAgent). The salt is an HMAC of the Dhaka
 * date with INTERNAL_API_KEY (a random value held in memory when the key is
 * unset); it is never written anywhere, so the hashes cannot be linked across
 * days. No IP, user agent, user id or URL is stored.
 */

export const MAX_EVENTS = 20;

let memorySalt = { day: "", salt: Buffer.alloc(0) };
const dailySalt = (day: string) => {
  if (config.internalApiKey) return createHmac("sha256", config.internalApiKey).update(`visitor:${day}`).digest();
  if (memorySalt.day !== day) memorySalt = { day, salt: randomBytes(32) };
  return memorySalt.salt;
};

export type IntakeInput = { body: unknown; ip: string; userAgent: string; optedOut: boolean };

export const ingestEvents = async ({ body, ip, userAgent, optedOut }: IntakeInput) => {
  if (optedOut || !userAgent || BOT_UA.test(userAgent)) return { accepted: 0, rejected: 0, skipped: true };

  const list = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(list)) {
    incrementMetrics([{ metric: "events.rejected" }]);
    return { accepted: 0, rejected: 1, skipped: false };
  }

  const counts = new Map<string, number>();
  let accepted = 0;
  let rejected = Math.max(0, list.length - MAX_EVENTS);
  for (const item of list.slice(0, MAX_EVENTS)) {
    const parsed = item && typeof item === "object" ? eventRows((item as any).name, (item as any).dim) : null;
    if (!parsed) {
      rejected += 1;
      continue;
    }
    accepted += 1;
    for (const dim of parsed.dims) {
      const key = `${parsed.event}\u0000${dim}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  if (rejected) incrementMetrics([{ metric: "events.rejected", by: rejected }]);
  if (!accepted) return { accepted, rejected, skipped: false };

  const day = dhakaDay();
  const hash = createHash("sha256").update(dailySalt(day)).update(ip).update("\u0000").update(userAgent).digest("hex");

  await prisma.$transaction([
    prisma.$executeRaw`
      INSERT INTO event_daily (day, event, dimension, count)
      VALUES ${Prisma.join(
        [...counts].map(([key, n]) => {
          const [event, dim] = key.split("\u0000");
          return Prisma.sql`(${day}::date, ${event}, ${dim}, ${n})`;
        }),
      )}
      ON CONFLICT (day, event, dimension) DO UPDATE SET count = event_daily.count + EXCLUDED.count`,
    prisma.$executeRaw`
      INSERT INTO visitor_daily (day, hash) VALUES (${day}::date, ${hash})
      ON CONFLICT (day, hash) DO NOTHING`,
  ]);

  return { accepted, rejected, skipped: false };
};
