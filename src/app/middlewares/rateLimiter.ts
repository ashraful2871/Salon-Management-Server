import { timingSafeEqual } from "crypto";
import { Request } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { isIP } from "net";
import config from "../../config";

const sameSecret = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * The visitor's address. The frontend calls this API from its own server, so
 * `req.ip` is Vercel's address for every visitor at once. Our Next.js server
 * forwards the real one in X-Client-IP - believed only alongside the shared
 * INTERNAL_API_KEY, since anyone else could write any address there.
 */
export const clientIp = (req: Request): string => {
  const forwarded = req.get("x-client-ip")?.trim();
  const key = req.get("x-internal-key");

  if (
    forwarded &&
    key &&
    config.internalApiKey &&
    sameSecret(key, config.internalApiKey) &&
    isIP(forwarded)
  ) {
    return forwarded;
  }

  return req.ip ?? "unknown";
};

/**
 * Signed-in callers by account, everyone else by their real IP. Needs
 * optionalAuth() (or auth()) to run before the limiter, or req.user is unset.
 * IPv6 addresses are grouped by /56 so one household is one bucket.
 */
export const userOrClientKey = (req: Request): string =>
  req.user?.userId
    ? `user:${req.user.userId}`
    : ipKeyGenerator(clientIp(req));

/**
 * Guards the credential and token endpoints: login, register, forgot-password,
 * reset-password, verify-email and resend-verification. Ten attempts per IP per
 * 15 minutes is generous for a human and useless for a brute-force script.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many attempts. Try again in 15 minutes.",
  },
});

/**
 * AI search is public but a call can spend Gemini quota on up to three model
 * requests, so it gets a tighter budget than an ordinary read endpoint.
 */
export const aiSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  keyGenerator: userOrClientKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many searches. Please wait a minute and try again.",
  },
});

/**
 * Map markers are public and re-fetched on every pan and zoom, so the budget
 * is loose for a person dragging a map but still stops a scraper walking
 * the whole country box by box.
 */
export const mapLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many map requests. Please wait a minute and try again.",
  },
});

/**
 * Address search and pin lookup are public and proxy free third-party
 * geocoders (Photon, Nominatim) whose fair-use terms we answer for. Both
 * endpoints share this budget; the frontend debounces typing, so a person
 * stays well under it.
 */
export const geoLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many address lookups. Please wait a minute and try again.",
  },
});

/**
 * Money endpoints: starting a top-up opens a gateway session and recording a
 * payment moves real balances. Twenty per 15 minutes is far more than any
 * honest customer needs and takes the fun out of scripting either one.
 */
export const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many payment attempts. Try again in 15 minutes.",
  },
});
