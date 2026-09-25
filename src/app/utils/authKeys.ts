import { createHmac } from "crypto";
import config from "../../config";
import ApiError from "../Error/error";

/**
 * Every secret the sign-in flows need is derived from AUTH_OTP_SECRET, one key
 * per purpose, so the OTP HMAC, the verification ticket and the Google flow
 * token can never be swapped for one another. None of them is JWT_SECRET: a
 * ticket must not pass as an access token, nor the other way round.
 */
export type AuthKeyPurpose = "otp" | "ticket" | "oauth-flow";

const MIN_SECRET_LENGTH = 32;

const keys = new Map<AuthKeyPurpose, Buffer>();

export const authKey = (purpose: AuthKeyPurpose): Buffer => {
  const cached = keys.get(purpose);
  if (cached) return cached;

  const secret = config.auth.otpSecret;

  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    console.error("[auth] AUTH_OTP_SECRET missing or short");
    throw new ApiError(500, "Email verification is not configured");
  }

  const key = createHmac("sha256", secret).update(`salon-auth:${purpose}`).digest();
  keys.set(purpose, key);

  return key;
};
