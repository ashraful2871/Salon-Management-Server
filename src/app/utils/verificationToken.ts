import crypto from "crypto";
import { TokenType } from "@prisma/client";
import prisma from "../shared/prisma";

export const PASSWORD_RESET_TTL_MINUTES = 15;
export const EMAIL_VERIFY_TTL_HOURS = 24;
export const RESEND_COOLDOWN_SECONDS = 60;

/** The emailed value is random; only its sha256 is ever persisted. */
export const hashToken = (token: string) =>
  crypto.createHash("sha256").update(token).digest("hex");

/**
 * Invalidates every outstanding token of this type for the user, then issues a
 * fresh one. Returns the raw token — this is the only moment it exists in
 * plaintext, so it must go straight into the email and nowhere else.
 */
export const issueToken = async (
  userId: string,
  type: TokenType,
  ttlMs: number
): Promise<string> => {
  const rawToken = crypto.randomBytes(32).toString("hex");

  await prisma.$transaction(async (tx) => {
    // One live token per user per type: consuming the old ones means a second
    // "forgot password" click cannot leave the first link working.
    await tx.verificationToken.updateMany({
      where: { userId, type, usedAt: null },
      data: { usedAt: new Date() },
    });

    await tx.verificationToken.create({
      data: {
        userId,
        type,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });
  });

  return rawToken;
};

/**
 * Looks up a raw token and marks it used in the same breath. Returns the userId,
 * or null when the token is unknown, already consumed, or expired — the caller
 * decides which of those to reveal.
 */
export const consumeToken = async (
  rawToken: string,
  type: TokenType
): Promise<string | null> => {
  const tokenHash = hashToken(rawToken);

  const record = await prisma.verificationToken.findUnique({
    where: { tokenHash },
  });

  if (
    !record ||
    record.type !== type ||
    record.usedAt !== null ||
    record.expiresAt.getTime() < Date.now()
  ) {
    return null;
  }

  // Conditional update: two concurrent requests race here and only one wins.
  const consumed = await prisma.verificationToken.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  if (consumed.count === 0) {
    return null;
  }

  return record.userId;
};

/** True when the user asked for a token of this type within the cooldown. */
export const isWithinCooldown = async (
  userId: string,
  type: TokenType,
  cooldownSeconds: number = RESEND_COOLDOWN_SECONDS
): Promise<boolean> => {
  const latest = await prisma.verificationToken.findFirst({
    where: { userId, type },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  if (!latest) return false;

  return Date.now() - latest.createdAt.getTime() < cooldownSeconds * 1000;
};
