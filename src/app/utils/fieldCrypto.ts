import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { StatusCodes } from "http-status-codes";
import config from "../../config";
import ApiError from "../Error/error";

/**
 * AES-256-GCM for sensitive fields at rest (payout bank account numbers), the
 * same "iv:tag:ciphertext" layout as the TOTP secrets in mfa.ts but under its
 * own key, PAYOUT_ENCRYPTION_KEY, so rotating one never touches the other.
 */

let cachedKey: Buffer | null = null;

/** Thrown at first use, so a missing key breaks bank accounts, not the whole API. */
const fieldKey = (): Buffer => {
  if (cachedKey) return cachedKey;
  const raw = config.payoutEncryptionKey;
  const key = raw ? Buffer.from(raw, "base64") : Buffer.alloc(0);
  if (key.length !== 32) {
    console.error("[fieldCrypto] PAYOUT_ENCRYPTION_KEY missing or not 32 bytes of base64");
    throw new ApiError(
      StatusCodes.INTERNAL_SERVER_ERROR,
      "Bank accounts are not configured yet. Please use bKash or Nagad, or try again later.",
    );
  }
  cachedKey = key;
  return key;
};

export const encryptField = (plain: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", fieldKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64")).join(":");
};

export const decryptField = (enc: string): string => {
  const [iv, tag, ct] = enc.split(":").map((p) => Buffer.from(p, "base64"));
  if (!iv || !tag || !ct) throw new Error("[fieldCrypto] malformed value");
  const decipher = createDecipheriv("aes-256-gcm", fieldKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
};
