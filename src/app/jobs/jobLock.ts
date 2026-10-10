import { PrismaClient } from "@prisma/client";

/**
 * Cross-instance job locks: Postgres session-level advisory locks taken on one
 * dedicated connection.
 *
 * The main client goes through Neon's pooler (PgBouncer, transaction mode),
 * where a session lock can be taken on one server connection and released on
 * another. So the locks use their own client on DIRECT_URL, capped at one
 * connection: lock and unlock always run on the same session, and a crashed
 * process drops its connection and with it every lock it held.
 */

let client: PrismaClient | null = null;
let warned = false;

const lockClient = () => {
  if (client) return client;
  const base = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!base) throw new Error("No database URL for job locks");
  if (!process.env.DIRECT_URL && !warned) {
    warned = true;
    console.warn("[jobs] DIRECT_URL is not set; job locks go through DATABASE_URL and may not hold across instances");
  }
  const url = new URL(base);
  url.searchParams.set("connection_limit", "1");
  client = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  return client;
};

// Two-key form, so job locks never share a key with any other advisory lock.
export const tryJobLock = async (name: string): Promise<boolean> => {
  const [row] = await lockClient().$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_lock(hashtext('jobs'), hashtext(${name})) AS locked`;
  return !!row?.locked;
};

export const releaseJobLock = async (name: string): Promise<void> => {
  await lockClient().$queryRaw`
    SELECT pg_advisory_unlock(hashtext('jobs'), hashtext(${name}))`;
};
