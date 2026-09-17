import rateLimit from "express-rate-limit";

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
 * AI search is public but every call spends Gemini quota on two model requests,
 * so it gets a tighter budget than an ordinary read endpoint.
 */
export const aiSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many searches. Please wait a minute and try again.",
  },
});
