import { randomInt } from "crypto";
import { Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { CODE_ALPHABET, codePrefix, normalizeCode } from "./referral.math";

/**
 * Referral codes: one per customer, made on first use. Upper-case, 8
 * characters: up to 5 letters of the first name padded from CODE_ALPHABET
 * (10 when 8 keeps colliding). A reset replaces the code; the old one stops
 * working at once.
 */

type Db = Prisma.TransactionClient | typeof prisma;

const WALK_IN_DOMAIN = "@walk-in.invalid";

const randomChars = (n: number) =>
  Array.from({ length: n }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");

const newCode = (prefix: string, length: number) => prefix + randomChars(Math.max(length - prefix.length, 3));

/**
 * Tries codes until one is free. Inserts with ON CONFLICT DO NOTHING
 * (`skipDuplicates`), so a taken code never aborts a surrounding transaction;
 * the row is then read back, which also returns a code a parallel call made
 * first. 5 tries at 8 characters, then 10.
 */
const insertCode = async (userId: string, name: string, db: Db) => {
  const prefix = codePrefix(name);
  for (let attempt = 0; attempt < 7; attempt++) {
    const code = newCode(prefix, attempt < 5 ? 8 : 10);
    await db.referralCode.createMany({ data: [{ userId, code }], skipDuplicates: true });
    const row = await db.referralCode.findUnique({ where: { userId } });
    if (row) return row;
  }
  throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, "Could not create a referral code. Please try again.");
};

/** The customer's code row, created if they have none. */
export const ensureCode = async (userId: string, db: Db = prisma) => {
  const existing = await db.referralCode.findUnique({ where: { userId } });
  if (existing) return existing;
  const user = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
  if (!user) throw new ApiError(StatusCodes.NOT_FOUND, "User not found");
  return insertCode(userId, user.name, db);
};

const referrerSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  status: true,
  emailVerified: true,
  isDeleted: true,
  isTest: true,
} satisfies Prisma.UserSelect;

export type ReferrerHit = Prisma.ReferralCodeGetPayload<{ include: { user: { select: typeof referrerSelect } } }>;

/** Who may refer: a verified, active, not deleted customer whose code is not blocked. */
export const isEligibleReferrer = (hit: ReferrerHit) =>
  !hit.blockedAt &&
  hit.user.role === "CUSTOMER" &&
  hit.user.status === "ACTIVE" &&
  hit.user.emailVerified &&
  !hit.user.isDeleted &&
  !hit.user.email.toLowerCase().endsWith(WALK_IN_DOMAIN);

/**
 * The code's owner, or null when the code is malformed, unknown, blocked or
 * its owner may not refer. One indexed read even for a malformed code, so a
 * miss takes about as long as a hit.
 */
export const findReferrerByCode = async (raw: string, db: Db = prisma): Promise<ReferrerHit | null> => {
  const code = normalizeCode(raw ?? "");
  const hit = await db.referralCode.findUnique({
    where: { code: code ?? "-" },
    include: { user: { select: referrerSelect } },
  });
  return hit && code && isEligibleReferrer(hit) ? hit : null;
};

/**
 * A new code for this customer (admin action), inside the caller's
 * transaction: the old code stops working immediately. Writes a `code_reset`
 * event (also when the customer had no code yet and one is made).
 */
export const resetCodeTx = async (tx: Prisma.TransactionClient, userId: string, actorId: string | null) => {
  const current = await tx.referralCode.findUnique({ where: { userId }, include: { user: { select: { name: true } } } });
  if (!current) {
    const row = await ensureCode(userId, tx);
    await tx.referralEvent.create({
      data: { type: "code_reset", actorId, data: { userId, oldCode: null, newCode: row.code } },
    });
    return { before: null, row };
  }

  const prefix = codePrefix(current.user.name);
  for (let attempt = 0; attempt < 7; attempt++) {
    const code = newCode(prefix, attempt < 5 ? 8 : 10);
    if (code === current.code) continue;
    const taken = await tx.referralCode.findUnique({ where: { code }, select: { userId: true } });
    if (taken) continue;
    const row = await tx.referralCode.update({ where: { userId }, data: { code } });
    await tx.referralEvent.create({
      data: { type: "code_reset", actorId, data: { userId, oldCode: current.code, newCode: code } },
    });
    return { before: current.code, row };
  }
  throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, "Could not create a new referral code. Please try again.");
};

/** `resetCodeTx` in a transaction of its own. */
export const resetCode = async (userId: string, actorId: string | null) =>
  prisma.$transaction(async (tx) => (await resetCodeTx(tx, userId, actorId)).row);
