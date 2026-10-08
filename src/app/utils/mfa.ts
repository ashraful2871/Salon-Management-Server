import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
} from "crypto";
import { StatusCodes } from "http-status-codes";
import { generateSecret, generateURI, verifySync } from "otplib";
import QRCode from "qrcode";
import config from "../../config";
import ApiError from "../Error/error";
import prisma from "../shared/prisma";

/**
 * TOTP second factor for ADMIN and AGENT accounts: 6 digits, 30 s steps, one
 * step of clock drift either way. The secret is AES-256-GCM encrypted at rest
 * with MFA_ENCRYPTION_KEY; recovery codes are stored as sha256 only.
 */

const ISSUER = "SalonKhuji";
const PERIOD_S = 30;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
/** Becomes the `security.stepUpMinutes` setting in Phase 7. */
export const STEP_UP_MINUTES = 10;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 10;
// No 0/O, 1/I/L: the codes are read off paper.
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

// ---------------------------------------------------------------- encryption

let cachedKey: Buffer | null = null;

/** Thrown at first use, so a missing key breaks 2FA, not the whole API. */
const encryptionKey = (): Buffer => {
  if (cachedKey) return cachedKey;
  const raw = config.mfa.key;
  const key = raw ? Buffer.from(raw, "base64") : Buffer.alloc(0);
  if (key.length !== 32) {
    console.error("[mfa] MFA_ENCRYPTION_KEY missing or not 32 bytes of base64");
    throw new ApiError(
      StatusCodes.INTERNAL_SERVER_ERROR,
      "Two-factor sign-in is not configured",
    );
  }
  cachedKey = key;
  return key;
};

/** AES-256-GCM, stored as "iv:tag:ciphertext" (base64 each). */
export const encrypt = (secret: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64")).join(":");
};

export const decrypt = (enc: string): string => {
  const [iv, tag, ct] = enc.split(":").map((p) => Buffer.from(p, "base64"));
  if (!iv || !tag || !ct) throw new Error("[mfa] malformed secret");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
};

// ---------------------------------------------------------------- enrolment

export const newTotpSecret = (): string => generateSecret();

/** The authenticator app shows it as "SalonKhuji:<email>". */
export const otpauthUrl = (email: string, secret: string) =>
  generateURI({ issuer: ISSUER, label: email, secret, period: PERIOD_S, digits: 6 });

export const qrDataUrl = (url: string): Promise<string> =>
  QRCode.toDataURL(url, { margin: 1, width: 240 });

/** "ABCDE FGHJK" style secret, easier to type than one 32-letter run. */
export const formatManualKey = (secret: string) =>
  secret.replace(/(.{4})/g, "$1 ").trim();

// ---------------------------------------------------------------- recovery

const normalizeRecovery = (code: string) =>
  code.toUpperCase().replace(/[^A-Z0-9]/g, "");

export const hashRecoveryCode = (code: string) =>
  createHash("sha256").update(normalizeRecovery(code)).digest("hex");

/** Ten codes, shown once as "ABCDE-FGHJK"; only their hashes are kept. */
export const generateRecoveryCodes = () => {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    let c = "";
    for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) {
      c += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    }
    return `${c.slice(0, 5)}-${c.slice(5)}`;
  });
  return { codes, hashes: codes.map(hashRecoveryCode) };
};

// ---------------------------------------------------------------- verification

const currentStep = () => Math.floor(Date.now() / 1000 / PERIOD_S);

const invalidCode = () =>
  ApiError.withCode(
    StatusCodes.BAD_REQUEST,
    "That code is not right. Check your authenticator app and try again.",
    "INVALID_TWO_FACTOR_CODE",
  );

const lockedError = (until: Date) =>
  ApiError.withCode(
    StatusCodes.TOO_MANY_REQUESTS,
    `Too many wrong codes. Try again in ${Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60000))} minutes.`,
    "TWO_FACTOR_LOCKED",
  );

type MfaRow = NonNullable<Awaited<ReturnType<typeof loadRow>>>;

const loadRow = (userId: string) =>
  prisma.userMfa.findUnique({ where: { userId } });

const assertUsable = (row: MfaRow | null, requireEnabled: boolean): MfaRow => {
  if (!row || (requireEnabled && !row.enabledAt)) {
    throw ApiError.withCode(
      StatusCodes.FORBIDDEN,
      "Set up two-factor sign-in first.",
      "TWO_FACTOR_SETUP_REQUIRED",
    );
  }
  if (row.lockedUntil && row.lockedUntil > new Date()) {
    throw lockedError(row.lockedUntil);
  }
  return row;
};

/**
 * Counts a wrong code. Five within 15 minutes lock the account's 2FA for 15
 * minutes. A success resets the count, so a non-zero count's updatedAt is the
 * last failure.
 */
const registerFailure = async (row: MfaRow): Promise<never> => {
  const stale =
    row.failedAttempts > 0 &&
    Date.now() - row.updatedAt.getTime() > FAILURE_WINDOW_MS;
  const failures = (stale ? 0 : row.failedAttempts) + 1;
  const lock = failures >= MAX_FAILURES;
  const lockedUntil = lock ? new Date(Date.now() + LOCK_MS) : null;

  await prisma.userMfa.update({
    where: { userId: row.userId },
    data: { failedAttempts: lock ? 0 : failures, lockedUntil },
  });

  throw lock ? lockedError(lockedUntil!) : invalidCode();
};

export type VerifyOpts = {
  /** false while enrolling (activate). Default true. */
  requireEnabled?: boolean;
  /**
   * The sign-in ticket's snapshot of lastUsedStep. Any accepted code moves
   * lastUsedStep on, so pinning it makes the ticket single-use.
   */
  ticketStep?: number | null;
};

/**
 * Checks a 6-digit TOTP code. Refuses while locked, refuses a code from a
 * step at or before the last accepted one (replay), and throws on failure.
 */
export const verifyCode = async (
  userId: string,
  code: string,
  opts: VerifyOpts = {},
): Promise<void> => {
  const row = assertUsable(await loadRow(userId), opts.requireEnabled ?? true);
  const token = code.replace(/\s/g, "");

  if (opts.ticketStep !== undefined && row.lastUsedStep !== opts.ticketStep) {
    throw ticketUsed();
  }

  let result: ReturnType<typeof verifySync> = { valid: false };
  if (/^\d{6}$/.test(token)) {
    try {
      result = verifySync({
        secret: decrypt(row.secretEnc),
        token,
        period: PERIOD_S,
        epochTolerance: PERIOD_S,
      });
    } catch (e) {
      if (e instanceof ApiError) throw e; // missing key
      console.error("[mfa] verify failed:", (e as Error).message);
    }
  }

  // The matched period start (s); present on TOTP results.
  const epoch = result.valid ? (result as { epoch?: number }).epoch : undefined;
  const step = typeof epoch === "number" ? Math.floor(epoch / PERIOD_S) : null;
  if (step === null || step <= (row.lastUsedStep ?? -1)) {
    return registerFailure(row);
  }

  // Conditional, so two requests racing with the same code cannot both pass.
  const claimed = await prisma.userMfa.updateMany({
    where: {
      userId,
      ...(opts.ticketStep !== undefined
        ? { lastUsedStep: opts.ticketStep }
        : { OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }] }),
    },
    data: { lastUsedStep: step, failedAttempts: 0, lockedUntil: null },
  });
  if (claimed.count === 0) {
    if (opts.ticketStep !== undefined) throw ticketUsed();
    return registerFailure(row);
  }
};

const ticketUsed = () =>
  ApiError.withCode(
    StatusCodes.BAD_REQUEST,
    "This sign-in was already completed or has expired. Please sign in again.",
    "TICKET_EXPIRED",
  );

/**
 * Spends one recovery code (removed in the same statement that matches it).
 * Also moves lastUsedStep to now, which closes the sign-in ticket.
 */
export const useRecoveryCode = async (
  userId: string,
  code: string,
  opts: { ticketStep?: number | null } = {},
): Promise<{ remaining: number }> => {
  const row = assertUsable(await loadRow(userId), true);

  if (opts.ticketStep !== undefined && row.lastUsedStep !== opts.ticketStep) {
    throw ticketUsed();
  }

  const hash = hashRecoveryCode(code);
  const step = Math.max(currentStep(), row.lastUsedStep ?? -1);
  const pinned = opts.ticketStep !== undefined;
  const ticketStep = opts.ticketStep ?? null;

  const count = await prisma.$executeRaw`
    UPDATE "user_mfa"
       SET "recoveryCodeHashes" = array_remove("recoveryCodeHashes", ${hash}),
           "lastUsedStep" = ${step},
           "failedAttempts" = 0,
           "lockedUntil" = NULL,
           "updatedAt" = NOW()
     WHERE "userId" = ${userId}
       AND ${hash} = ANY("recoveryCodeHashes")
       AND (${!pinned}::boolean OR "lastUsedStep" IS NOT DISTINCT FROM ${ticketStep}::int)`;

  if (count === 0) return registerFailure(row);

  return { remaining: Math.max(0, row.recoveryCodeHashes.length - 1) };
};

// ---------------------------------------------------------------- state

export const mfaStatus = async (userId: string) => {
  const row = await prisma.userMfa.findUnique({
    where: { userId },
    select: { enabledAt: true, stepUpUntil: true, recoveryCodeHashes: true },
  });
  const now = new Date();
  return {
    enrolled: !!row?.enabledAt,
    enabledAt: row?.enabledAt ?? null,
    stepUpUntil:
      row?.stepUpUntil && row.stepUpUntil > now ? row.stepUpUntil : null,
    recoveryCodesLeft: row?.enabledAt ? row.recoveryCodeHashes.length : 0,
  };
};

/** The lastUsedStep a sign-in ticket pins, or null when 2FA is not enabled. */
export const enabledMfaStep = async (
  userId: string,
): Promise<{ step: number | null } | null> => {
  const row = await prisma.userMfa.findUnique({
    where: { userId },
    select: { enabledAt: true, lastUsedStep: true },
  });
  return row?.enabledAt ? { step: row.lastUsedStep } : null;
};

export const openStepUp = async (userId: string): Promise<Date> => {
  const until = new Date(Date.now() + STEP_UP_MINUTES * 60 * 1000);
  await prisma.userMfa.update({ where: { userId }, data: { stepUpUntil: until } });
  return until;
};
