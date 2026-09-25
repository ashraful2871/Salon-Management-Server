/**
 * bKash allows at most 2 Grant Token calls an hour and blocks the merchant for
 * an hour after that, so a token is granted once and shared by every process:
 * memory first, then the `gateway_tokens` row, then a refresh, and a grant only
 * when all of those fail. An advisory lock makes one process do the refresh or
 * grant while any others wait and then read its row.
 */
import prisma from "../../../../shared/prisma";
import config from "../../../../../config";
import { bkashRequest } from "./bkash.client";

type GrantResponse = {
  id_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
};

type Token = { token: string; expiresAt: Date };

const PROVIDER = "BKASH";
/** Treat a token as gone this long before bKash does. */
const SAFETY_MS = 10 * 60 * 1000;

let memory: Token | null = null;
let inFlight: Promise<string> | null = null;

const usable = (expiresAt: Date) => expiresAt.getTime() - SAFETY_MS > Date.now();

class BkashTokenError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const logSource = (source: "memory" | "db" | "refresh" | "grant", expiresAt: Date) => {
  const line = `[bkash] token source=${source} expiresAt=${expiresAt.toISOString()}`;
  if (source === "grant") console.warn(line);
  else console.log(line);
};

const load = () =>
  prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('bkash-token', 0))`;

      const row = await tx.gatewayToken.findUnique({ where: { provider: PROVIDER } });
      if (row && usable(row.expiresAt)) {
        return { token: row.accessToken, expiresAt: row.expiresAt, source: "db" as const };
      }

      const save = async (granted: GrantResponse, fallbackRefresh: string | null) => {
        const seconds = Number(granted.expires_in);
        const expiresAt = new Date(
          Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000,
        );
        const data = {
          accessToken: granted.id_token as string,
          refreshToken: granted.refresh_token ?? fallbackRefresh,
          expiresAt,
        };
        await tx.gatewayToken.upsert({
          where: { provider: PROVIDER },
          create: { provider: PROVIDER, ...data },
          update: data,
        });
        return { token: data.accessToken, expiresAt };
      };

      if (row?.refreshToken) {
        const refreshed = await bkashRequest<GrantResponse>(
          "/token/refresh",
          {
            app_key: config.bkash.appKey,
            app_secret: config.bkash.appSecret,
            refresh_token: row.refreshToken,
          },
          { auth: "credentials", op: "token.refresh" },
        );
        // A failed refresh falls through to a grant.
        if (refreshed.ok && refreshed.data.id_token) {
          return { ...(await save(refreshed.data, row.refreshToken)), source: "refresh" as const };
        }
      }

      const granted = await bkashRequest<GrantResponse>(
        "/token/grant",
        { app_key: config.bkash.appKey, app_secret: config.bkash.appSecret },
        { auth: "credentials", op: "token.grant" },
      );
      if (!granted.ok) throw new BkashTokenError(granted.code, granted.message);
      if (!granted.data.id_token) {
        throw new BkashTokenError("BAD_RESPONSE", "bKash granted no token");
      }
      return { ...(await save(granted.data, null)), source: "grant" as const };
    },
    { maxWait: 10_000, timeout: 45_000 },
  );

export const getBkashToken = async (): Promise<string> => {
  if (memory && usable(memory.expiresAt)) {
    logSource("memory", memory.expiresAt);
    return memory.token;
  }

  // Single flight: concurrent callers in this process share one load.
  if (!inFlight) {
    inFlight = load()
      .then(({ token, expiresAt, source }) => {
        memory = { token, expiresAt };
        logSource(source, expiresAt);
        return token;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
};

/**
 * bKash rejected a token. Expire it rather than delete it, so the next load can
 * still refresh instead of spending a grant. With `token`, only that token is
 * expired: another process may already have stored a newer one.
 */
export const invalidateBkashToken = async (token?: string) => {
  memory = null;
  try {
    await prisma.gatewayToken.updateMany({
      where: { provider: PROVIDER, ...(token ? { accessToken: token } : {}) },
      data: { expiresAt: new Date() },
    });
  } catch (err) {
    console.error("[bkash] could not expire the stored token", (err as Error).message);
  }
};
