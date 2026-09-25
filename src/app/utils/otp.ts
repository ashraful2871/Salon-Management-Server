import { createHmac, randomInt, randomUUID, timingSafeEqual } from "crypto";
import { OtpPurpose } from "@prisma/client";
import prisma from "../shared/prisma";
import config from "../../config";
import { authKey } from "./authKeys";

export const OTP_LENGTH = 6;
export const OTP_TTL_SECONDS = 10 * 60;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_SECONDS = 60;
export const OTP_HOURLY_LIMIT = 5;
export const OTP_DAILY_LIMIT = 10;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The row id is part of the MAC, so a code is only valid against the challenge
 * it was issued for, and the same six digits hash differently every time.
 */
const hmac = (id: string, code: string) =>
  createHmac("sha256", authKey("otp")).update(`${id}:${code}`).digest("hex");

const secondsUntil = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

/**
 * Seconds before this user may be sent another code for this purpose, or 0.
 * Counts every issued row, used or not: the limits cap emails sent, not codes
 * entered. When several limits bite, the longest wait wins, so a caller that
 * retries after `retryAfter` is not turned away again.
 */
const throttleWait = async (userId: string, purpose: OtpPurpose, now: number) => {
  const rows = await prisma.otpChallenge.findMany({
    where: { userId, purpose, createdAt: { gt: new Date(now - DAY_MS) } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });

  if (rows.length === 0) return 0;

  let wait = 0;

  const latest = rows[rows.length - 1].createdAt.getTime();
  const sinceLatest = now - latest;
  if (sinceLatest < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
    wait = Math.max(wait, secondsUntil(OTP_RESEND_COOLDOWN_SECONDS * 1000 - sinceLatest));
  }

  const lastHour = rows.filter((r) => r.createdAt.getTime() > now - HOUR_MS);
  if (lastHour.length >= OTP_HOURLY_LIMIT) {
    wait = Math.max(wait, secondsUntil(lastHour[0].createdAt.getTime() + HOUR_MS - now));
  }

  if (rows.length >= OTP_DAILY_LIMIT) {
    wait = Math.max(wait, secondsUntil(rows[0].createdAt.getTime() + DAY_MS - now));
  }

  return wait;
};

export type IssueOtpResult =
  | { ok: true; code: string; expiresAt: Date }
  | { ok: false; retryAfter: number };

/**
 * Issues a fresh code and supersedes every earlier live one for this purpose.
 * Returns the plaintext code: this is the only moment it exists, so it goes
 * straight into the email and nowhere else.
 */
export const issueOtp = async ({
  userId,
  purpose,
  target,
  ip,
}: {
  userId: string;
  purpose: OtpPurpose;
  target: string;
  ip?: string | null;
}): Promise<IssueOtpResult> => {
  const now = Date.now();

  const retryAfter = await throttleWait(userId, purpose, now);
  if (retryAfter > 0) return { ok: false, retryAfter };

  const code = randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, "0");
  const id = randomUUID();
  const expiresAt = new Date(now + OTP_TTL_SECONDS * 1000);

  await prisma.$transaction([
    prisma.otpChallenge.updateMany({
      where: { userId, purpose, consumedAt: null },
      data: { consumedAt: new Date(now) },
    }),
    prisma.otpChallenge.create({
      data: {
        id,
        userId,
        purpose,
        channel: "EMAIL",
        target,
        codeHash: hmac(id, code),
        maxAttempts: OTP_MAX_ATTEMPTS,
        expiresAt,
        requestIp: ip ?? null,
      },
    }),
  ]);

  if (config.auth.devLogOtp) {
    console.log(`[otp:dev] ${target} -> ${code}`);
  }

  return { ok: true, code, expiresAt };
};

export type OtpFailure = "INVALID" | "NONE" | "EXPIRED" | "LOCKED";

export type VerifyOtpResult =
  | { ok: true; target: string }
  | { ok: false; reason: OtpFailure; attemptsLeft?: number };

/**
 * Checks a code against the user's live challenge. Every well-formed guess
 * spends an attempt before it is compared, through a conditional increment, so
 * parallel guesses cannot exceed `maxAttempts`. `target`, when given, pins the
 * check to the address the caller expects the code to have gone to.
 */
export const verifyOtp = async ({
  userId,
  purpose,
  code,
  target,
}: {
  userId: string;
  purpose: OtpPurpose;
  code: string;
  target?: string;
}): Promise<VerifyOtpResult> => {
  // A malformed code costs nothing: it cannot be a guess at the real one.
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, reason: "INVALID", attemptsLeft: undefined };
  }

  const now = new Date();

  const c = await prisma.otpChallenge.findFirst({
    where: { userId, purpose, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!c || (target && c.target !== target)) return { ok: false, reason: "NONE" };
  if (c.expiresAt <= now) return { ok: false, reason: "EXPIRED" };
  if (c.attempts >= c.maxAttempts) return { ok: false, reason: "LOCKED" };

  const bumped = await prisma.otpChallenge.updateMany({
    where: {
      id: c.id,
      consumedAt: null,
      attempts: { lt: c.maxAttempts },
      expiresAt: { gt: now },
    },
    data: { attempts: { increment: 1 } },
  });

  if (bumped.count === 0) {
    // Something changed since the read: say which, as best we can.
    const fresh = await prisma.otpChallenge.findUnique({ where: { id: c.id } });
    if (!fresh) return { ok: false, reason: "NONE" };
    if (fresh.expiresAt <= now) return { ok: false, reason: "EXPIRED" };
    if (fresh.attempts >= fresh.maxAttempts) return { ok: false, reason: "LOCKED" };
    // Consumed by a parallel success or superseded by a newer code.
    return { ok: false, reason: "NONE" };
  }

  const given = Buffer.from(hmac(c.id, code), "hex");
  const stored = Buffer.from(c.codeHash, "hex");
  const match = given.length === stored.length && timingSafeEqual(given, stored);

  if (!match) {
    const left = c.maxAttempts - (c.attempts + 1);

    if (left <= 0) {
      // Burn it, so the lockout also shows up as "no live code" everywhere else.
      await prisma.otpChallenge.updateMany({
        where: { id: c.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
    }

    return {
      ok: false,
      reason: left <= 0 ? "LOCKED" : "INVALID",
      attemptsLeft: Math.max(left, 0),
    };
  }

  // Conditional update: two correct submissions race here and only one wins.
  const won = await prisma.otpChallenge.updateMany({
    where: { id: c.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  return won.count === 1 ? { ok: true, target: c.target } : { ok: false, reason: "NONE" };
};

/**
 * What the code screen shows: seconds until the newest code expires (0 when it
 * is used, superseded or there is none) and seconds until another may be sent.
 */
export const otpTimings = async (userId: string, purpose: OtpPurpose) => {
  const now = Date.now();

  const latest = await prisma.otpChallenge.findFirst({
    where: { userId, purpose },
    orderBy: { createdAt: "desc" },
    select: { expiresAt: true, consumedAt: true },
  });

  const expiresIn =
    latest && !latest.consumedAt
      ? Math.max(0, Math.ceil((latest.expiresAt.getTime() - now) / 1000))
      : 0;

  return { expiresIn, resendIn: await throttleWait(userId, purpose, now) };
};

/**
 * "ashraful@gmail.com" -> "as******@gmail.com". Keeps two characters of the
 * local part (one when it has two or fewer) and the whole domain, and always
 * masks at least one character.
 */
export const maskEmail = (email: string) => {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";

  const local = email.slice(0, at);
  const keep = local.length <= 2 ? 1 : 2;

  return `${local.slice(0, keep)}${"*".repeat(Math.max(1, local.length - keep))}${email.slice(at)}`;
};
