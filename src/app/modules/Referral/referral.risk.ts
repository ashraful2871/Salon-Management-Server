import { createHmac } from "crypto";
import { isIP } from "net";
import { Request } from "express";
import { Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import config from "../../../config";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { clientIp } from "../../middlewares/rateLimiter";
import { getSetting } from "../../utils/settings";

/**
 * Soft fraud signals for referrals. Everything here is a hash: the raw device
 * id, IP and phone are never stored or logged. A flag never refuses a sign-up;
 * it is saved on the referral and, if still present when it qualifies, holds
 * the referrer's reward for review (`referral.holdFlagged`).
 */

type Db = Prisma.TransactionClient | typeof prisma;

/** HMAC-SHA256(REFERRAL_HASH_SECRET, value), hex. A missing secret is a 500 only when a hash is needed. */
export const hmac = (value: string): string => {
  const secret = config.referral.hashSecret;
  if (!secret) {
    throw ApiError.withCode(
      StatusCodes.INTERNAL_SERVER_ERROR,
      "Referrals are not configured on this server (REFERRAL_HASH_SECRET is missing).",
      "REFERRAL_NOT_CONFIGURED",
    );
  }
  return createHmac("sha256", secret).update(value).digest("hex");
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `sm_did` device cookie the frontend forwards as `X-Device-Id`. Only a
 * UUID is accepted; anything else reads as no device.
 */
export const deviceHashOf = (req: Request): string | null => {
  const id = req.get("x-device-id")?.trim();
  return id && UUID.test(id) ? hmac(id.toLowerCase()) : null;
};

/**
 * The visitor's IP, hashed. In production every request reaches us from the
 * Next.js server, so an address that was not forwarded with INTERNAL_API_KEY
 * is the frontend's own and says nothing about the visitor (it would make
 * every referral look SAME_NETWORK): null then.
 */
export const ipHashOf = (req: Request): string | null => {
  let ip = clientIp(req);
  if (config.env === "production" && ip !== req.get("x-client-ip")?.trim()) return null;
  if (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? hmac(ip) : null;
};

export type SignupSignals = { ipHash: string | null; deviceHash: string | null };

/**
 * The request's signals, worked out on first use: a sign-up without a code
 * never needs the hash secret.
 */
export const signalsOf = (req: Request): (() => SignupSignals) => {
  let cached: SignupSignals | undefined;
  return () => (cached ??= { ipHash: ipHashOf(req), deviceHash: deviceHashOf(req) });
};

/** Well-known throwaway inbox providers. Small on purpose: a flag, not a wall. */
export const DISPOSABLE_DOMAINS = new Set([
  "10minutemail.com",
  "10minutemail.net",
  "20minutemail.com",
  "burnermail.io",
  "discard.email",
  "dispostable.com",
  "emailondeck.com",
  "fakeinbox.com",
  "getnada.com",
  "nada.email",
  "grr.la",
  "guerrillamail.com",
  "guerrillamail.net",
  "guerrillamail.org",
  "sharklasers.com",
  "inboxkitten.com",
  "maildrop.cc",
  "mailinator.com",
  "mailnesia.com",
  "mintemail.com",
  "moakt.com",
  "mohmal.com",
  "mytemp.email",
  "spamgourmet.com",
  "tempail.com",
  "temp-mail.io",
  "temp-mail.org",
  "tempmail.com",
  "tempmail.net",
  "tempr.email",
  "throwawaymail.com",
  "tmpmail.org",
  "trashmail.com",
  "trashmail.net",
  "yopmail.com",
  "yopmail.net",
]);

export const isDisposableEmail = (email: string) => {
  const domain = email.trim().toLowerCase().split("@").pop() ?? "";
  return DISPOSABLE_DOMAINS.has(domain);
};

export type SignupFlag = "SAME_DEVICE" | "SAME_NETWORK" | "VELOCITY" | "DISPOSABLE_EMAIL";

/**
 * The soft flags known at sign-up. `code` is the referrer's ReferralCode row.
 * VELOCITY: this referrer already has `referral.velocityPerDay` or more
 * attaches in the last 24 h, so with the default 5 the 6th is flagged.
 */
export const signupFlags = async ({
  code,
  refereeEmail,
  ipHash,
  deviceHash,
  db = prisma,
}: {
  code: { userId: string; deviceHashes: string[]; ipHashes: string[] };
  refereeEmail: string;
  ipHash: string | null;
  deviceHash: string | null;
  db?: Db;
}): Promise<SignupFlag[]> => {
  const flags: SignupFlag[] = [];
  if (deviceHash && code.deviceHashes.includes(deviceHash)) flags.push("SAME_DEVICE");
  if (ipHash && code.ipHashes.includes(ipHash)) flags.push("SAME_NETWORK");

  const [perDay, recent] = await Promise.all([
    getSetting("referral.velocityPerDay"),
    db.referral.count({
      where: { referrerId: code.userId, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    }),
  ]);
  if (recent >= perDay) flags.push("VELOCITY");

  if (isDisposableEmail(refereeEmail)) flags.push("DISPOSABLE_EMAIL");
  return flags;
};

/**
 * Remembers the device and network the referrer opened their Refer page from
 * (the last 5 of each, newest last), so a friend signing up on the same phone
 * or Wi-Fi is flagged. One UPDATE, and only when the newest entry changes.
 */
export const rememberReferrerDevice = async (userId: string, req: Request): Promise<void> => {
  const { deviceHash, ipHash } = signalsOf(req)();
  if (!deviceHash && !ipHash) return;

  const keepLast5 = (col: Prisma.Sql, h: string | null) =>
    h
      ? Prisma.sql`(SELECT coalesce(array_agg(x ORDER BY n), '{}') FROM (
           SELECT x, n FROM unnest(array_append(array_remove(${col}, ${h}::text), ${h}::text))
             WITH ORDINALITY AS t(x, n)
           ORDER BY n DESC LIMIT 5) s)`
      : col;
  const isNewest = (col: Prisma.Sql, h: string | null) =>
    h ? Prisma.sql`${col}[cardinality(${col})] IS NOT DISTINCT FROM ${h}::text` : Prisma.sql`true`;

  const dev = Prisma.sql`"deviceHashes"`;
  const ips = Prisma.sql`"ipHashes"`;

  await prisma.$executeRaw`
    UPDATE "referral_codes"
       SET "deviceHashes" = ${keepLast5(dev, deviceHash)},
           "ipHashes" = ${keepLast5(ips, ipHash)},
           "updatedAt" = now()
     WHERE "userId" = ${userId}
       AND NOT (${isNewest(dev, deviceHash)} AND ${isNewest(ips, ipHash)})`;
};
