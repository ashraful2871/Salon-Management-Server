import { timingSafeEqual } from "crypto";
import { NextFunction, Request, Response } from "express";
import rateLimit, { ipKeyGenerator, type Options } from "express-rate-limit";
import { isIP } from "net";
import config from "../../config";
import { DAILY_CONVERSATIONS } from "../modules/Assistant/assistant.constants";
import { logUnrecorded } from "../modules/Assistant/assistant.log";

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
 *
 * Per account, not per IP: every call reaches us from the Next.js server, so
 * keyed on `req.ip` this was one bucket of twenty shared by every customer at
 * once. Every route it guards is signed-in only, and it must be mounted after
 * `auth(...)` so `req.user` is set.
 */
export const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: userOrClientKey, // auth() must run first
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many payment attempts. Try again in 15 minutes.",
  },
});

/**
 * A refused assistant call is still a turn in the funnel report, so every
 * assistant limiter writes the same `[assistant]` line a turn does — the id
 * from the URL and the action type only, nothing the customer sent.
 */
const assistantLimited = (
  req: Request,
  res: Response,
  _next: NextFunction,
  options: Options,
) => {
  logUnrecorded({
    cid: req.params?.id ?? null,
    // A tap names its action; anything else is named by its route
    // ("messages", "confirm", "conversations").
    action: req.body?.action?.type ?? req.path.split("/").pop() ?? null,
    outcome: "rate_limited",
  });
  res.status(options.statusCode).json(options.message);
};

/**
 * Typed messages are the one assistant call that can reach Gemini, so they get
 * their own, tighter budget — tighter still for guests, who cost the same and
 * are cheaper to multiply. The per-conversation cap is `MAX_TURNS`.
 */
export const assistantLlmLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: (req: Request) => (req.user?.userId ? 20 : 10),
  keyGenerator: userOrClientKey, // optionalAuth() must run first
  standardHeaders: true,
  legacyHeaders: false,
  handler: assistantLimited,
  message: {
    success: false,
    message: "You are typing faster than I can read. Please wait a minute.",
  },
});

/**
 * Guided turns are DB reads, so this is generous — it exists to stop a script,
 * not a fast tapper. The model-backed endpoint gets its own budget later.
 */
export const assistantLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: userOrClientKey, // optionalAuth() must run first
  standardHeaders: true,
  legacyHeaders: false,
  handler: assistantLimited,
  message: {
    success: false,
    message: "Too many messages. Please wait a minute.",
  },
});

/**
 * New conversations per rolling day: 30 per account, 10 per visitor address.
 * `MAX_TURNS` caps how long one chat runs; this caps how many a script can
 * open to get around it. Guests are counted by address because a guest's
 * only other identity is the key we hand them *on* create.
 *
 * Needs `INTERNAL_API_KEY` on both hosts in production: without it every guest
 * arrives as the Vercel server's address and ten chats a day is the whole
 * site's guest allowance.
 */
export const assistantStartLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: (req: Request) =>
    req.user?.userId ? DAILY_CONVERSATIONS.signedIn : DAILY_CONVERSATIONS.guest,
  keyGenerator: userOrClientKey, // optionalAuth() must run first
  standardHeaders: true,
  legacyHeaders: false,
  handler: assistantLimited,
  message: {
    success: false,
    message:
      "You have started a lot of chats today. Carry on with an earlier one, or try again tomorrow.",
  },
});
