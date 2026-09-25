import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(process.cwd(), ".env") });
// Define the shape of the configuration object
interface Config {
  env: string | undefined;
  port: string | undefined;
  database_url: string | undefined;
  jwt: {
    jwt_secret: string;
    expires_in: string;
    refresh_token_secret: string;
    refresh_token_expires_in: string;
  };
  frontend_url: string;
  cloudinary: {
    cloud_name: string | undefined;
    api_key: string | undefined;
    api_secret: string | undefined;
  };
  sslcz: {
    storeId: string;
    storePasswd: string;
    isLive: boolean;
    successUrl: string;
    failUrl: string;
    cancelUrl: string;
    ipnUrl: string;
  };
  bkash: {
    enabled: boolean;
    isLive: boolean;
    baseUrl: string;
    username: string;
    password: string;
    appKey: string;
    appSecret: string;
    callbackUrl: string;
  };
  email: {
    provider: string;
    from: string;
    resendApiKey: string;
    smtp: {
      host: string;
      port: number;
      user: string;
      pass: string;
    };
  };
  geo: {
    userAgent: string;
    nominatimUrl: string;
    photonUrl: string;
  };
  ai: {
    geminiApiKey: string;
    embeddingModel: string;
    chatModels: string[];
    searchLimit: number;
  };
  internalApiKey: string;
  auth: {
    otpSecret: string;
    requireEmailVerification: boolean;
    devLogOtp: boolean;
  };
  google: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    signupRequiresOtp: boolean;
  };
}
//

/**
 * Reads an env var the way a dashboard actually hands it over.
 *
 * `dotenv` already trims and unquotes what it parses out of a `.env` file, but
 * nothing does that for a variable typed into Render's Environment tab. A value
 * pasted there keeps whatever came with it - a trailing space or newline from
 * the clipboard, or the surrounding quotes copied along with a `.env` line - and
 * that is the difference between a secret that works locally and the same
 * secret rejected in production. `Bearer "re_abc "` is not `Bearer re_abc`.
 */
const env = (name: string): string => {
  const raw = process.env[name];

  if (raw === undefined) return "";

  const trimmed = raw.trim();

  // Only a matched pair, so an API key that legitimately contains a quote in
  // the middle is left alone.
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1).trim()
      : trimmed;

  if (unquoted !== raw) {
    console.warn(
      `[config] ${name} had surrounding whitespace or quotes; using the cleaned value. Fix it at the source - other tools reading this variable will not clean it.`,
    );
  }

  return unquoted;
};

const frontendUrl = env("FRONTEND_URL") || "http://localhost:3000";
const apiUrl = env("API_URL") || "http://localhost:5000";

/**
 * Production always sets EMAIL_FROM. The fallbacks only keep a developer who
 * has not set it from sending as a stranger: with SMTP the authenticated
 * mailbox is the only address the server is entitled to use anyway, and
 * Resend's shared test sender is the equivalent for the API.
 */
const emailFrom =
  env("EMAIL_FROM") ||
  (env("SMTP_USER") && !env("RESEND_API_KEY")
    ? `Salon Management <${env("SMTP_USER")}>`
    : "Salon Management <onboarding@resend.dev>");

const config = {
  env: process.env.NODE_ENV,
  port: process.env.PORT,
  database_url: process.env.DATABASE_URL,
  frontend_url: frontendUrl,
  jwt: {
    jwt_secret: process.env.JWT_SECRET || "",
    expires_in: process.env.EXPIRES_IN || "1h",
    refresh_token_secret: process.env.REFRESH_TOKEN_SECRET || "",
    refresh_token_expires_in: process.env.REFRESH_TOKEN_EXPIRES_IN || "90d",
  },
  cloudinary: {
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  },
  /**
   * Email. `provider` pins the transport ("resend" | "smtp"); left empty, the
   * first one with credentials wins, which prefers the HTTPS API over SMTP.
   *
   * That order matters in production: hosted free tiers block outbound SMTP
   * (587), so nodemailer fails there with ETIMEDOUT and then ENETUNREACH on the
   * IPv6 retry, while an HTTPS API on 443 always gets out.
   *
   * `from` must be an address on a domain verified with the provider.
   * Resend's shared `onboarding@resend.dev` works for testing but only
   * delivers to the account owner's own address.
   */
  email: {
    provider: env("EMAIL_PROVIDER"),
    from: emailFrom,
    resendApiKey: env("RESEND_API_KEY"),
    smtp: {
      host: env("SMTP_HOST"),
      port: Number(env("SMTP_PORT")) || 587,
      user: env("SMTP_USER"),
      // Gmail app passwords are shown in four groups of four; the spaces are
      // display only and are rejected if they are sent.
      pass: env("SMTP_PASS").replace(/\s+/g, ""),
    },
  },

  /**
   * SSLCommerz. The return URLs must be publicly reachable - the gateway posts
   * to them from its own servers, so `localhost` will never be called. Use an
   * ngrok tunnel while developing, and register the IPN URL in the merchant
   * panel as well: it is not picked up from the API call alone.
   */
  sslcz: {
    storeId: process.env.SSLCZ_STORE_ID || "",
    storePasswd: process.env.SSLCZ_STORE_PASSWD || "",
    isLive: process.env.SSLCZ_IS_LIVE === "true",
    successUrl:
      process.env.SSLCZ_SUCCESS_URL ||
      `${apiUrl}/api/v1/payments/sslcz/success`,
    failUrl:
      process.env.SSLCZ_FAIL_URL || `${apiUrl}/api/v1/payments/sslcz/fail`,
    cancelUrl:
      process.env.SSLCZ_CANCEL_URL || `${apiUrl}/api/v1/payments/sslcz/cancel`,
    ipnUrl: process.env.SSLCZ_IPN_URL || `${apiUrl}/api/v1/payments/sslcz/ipn`,
  },
  /**
   * bKash Tokenized Checkout. There is no server-to-server notification: the
   * callback is the customer's browser coming back, so `localhost` works
   * without a tunnel. Trust comes from the execute and query calls, never from
   * the callback's own parameters.
   */
  bkash: {
    enabled: process.env.BKASH_ENABLED === "true",
    isLive: process.env.BKASH_IS_LIVE === "true",
    baseUrl: (
      process.env.BKASH_BASE_URL ||
      (process.env.BKASH_IS_LIVE === "true"
        ? "https://tokenized.pay.bka.sh/v1.2.0-beta"
        : "https://tokenized.sandbox.bka.sh/v1.2.0-beta")
    ).replace(/\/+$/, ""),
    username: process.env.BKASH_USERNAME || "",
    password: process.env.BKASH_PASSWORD || "",
    appKey: process.env.BKASH_APP_KEY || "",
    appSecret: process.env.BKASH_APP_SECRET || "",
    callbackUrl:
      process.env.BKASH_CALLBACK_URL ||
      `${apiUrl}/api/v1/payments/bkash/callback`,
  },

  /**
   * Geocoding. Photon answers search-as-you-type; Nominatim answers reverse
   * lookups and bans autocomplete. Nominatim's usage policy also requires a
   * User-Agent naming the app and a real contact - set GEOCODER_USER_AGENT in
   * production, the placeholder below is not one.
   */
  geo: {
    userAgent:
      env("GEOCODER_USER_AGENT") ||
      "SalonManagement/1.0 (contact: you@yourdomain.com)",
    nominatimUrl: (
      env("NOMINATIM_URL") || "https://nominatim.openstreetmap.org"
    ).replace(/\/+$/, ""),
    photonUrl: (env("PHOTON_URL") || "https://photon.komoot.io").replace(
      /\/+$/,
      "",
    ),
  },

  /**
   * AI search (Gemini). The embedding model is one fixed id: vectors from two
   * models are not comparable, so there is no fallback for it, and changing it
   * re-embeds every salon (the indexer notices on its own).
   *
   * GEMINI_CHAT_MODEL is a comma-separated preference list. The first model
   * that answers in time wins; one that fails is skipped for a while. The
   * default leads with gemini-2.5-flash because this project already uses it -
   * since 2026-09-18 Google only grants 2.5 access to projects that do, so a new
   * project should lead with a 3.x Flash-Lite instead.
   */
  ai: {
    geminiApiKey: env("GEMINI_API_KEY"),
    embeddingModel: env("GEMINI_EMBEDDING_MODEL") || "gemini-embedding-2",
    chatModels: (
      env("GEMINI_CHAT_MODEL") || "gemini-2.5-flash,gemini-3.5-flash-lite"
    )
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean),
    searchLimit: Math.min(Math.max(Number(env("AI_SEARCH_LIMIT")) || 6, 1), 12),
  },

  /**
   * Shared secret between the Next.js server and this API. Every call the
   * frontend makes comes from its server, so without it `req.ip` is Vercel's
   * address for every visitor. With it, a limiter may trust the visitor's IP
   * that the frontend forwards in X-Client-IP. Empty turns that off.
   */
  internalApiKey: env("INTERNAL_API_KEY"),

  /**
   * Email verification by 6-digit code. `otpSecret` is the root that the OTP
   * HMAC, the verification ticket and the Google flow token each derive their
   * own key from (see utils/authKeys.ts); it is never JWT_SECRET. The flag
   * turns the check on for sign-in; off, accounts sign in as they do today.
   * `devLogOtp` prints codes to the console and can never be on in production.
   */
  auth: {
    otpSecret: env("AUTH_OTP_SECRET"),
    requireEmailVerification: env("REQUIRE_EMAIL_VERIFICATION") === "true",
    devLogOtp: env("AUTH_DEV_LOG_OTP") === "true" && process.env.NODE_ENV !== "production",
  },

  /**
   * Google sign-in (Authorization Code + PKCE). The redirect lands on the
   * frontend's route handler, which hands the code to this API, so it defaults
   * to FRONTEND_URL. A brand-new account made through Google still proves the
   * inbox with a code unless GOOGLE_SIGNUP_REQUIRES_OTP is "false".
   */
  google: {
    clientId: env("GOOGLE_CLIENT_ID"),
    clientSecret: env("GOOGLE_CLIENT_SECRET"),
    redirectUri: env("GOOGLE_REDIRECT_URI") || `${frontendUrl}/api/auth/google/callback`,
    signupRequiresOtp: env("GOOGLE_SIGNUP_REQUIRES_OTP") !== "false",
  },
} as Config;

/** Google sign-in is offered only when all three of its settings are present. */
export const isGoogleEnabled = () =>
  Boolean(config.google.clientId && config.google.clientSecret && config.google.redirectUri);

export default config;
