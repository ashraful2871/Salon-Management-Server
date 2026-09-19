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
}
//

const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
const apiUrl = process.env.API_URL || "http://localhost:5000";

/**
 * Production always sets EMAIL_FROM. The fallbacks only keep a developer who
 * has not set it from sending as a stranger: with SMTP the authenticated
 * mailbox is the only address the server is entitled to use anyway, and
 * Resend's shared test sender is the equivalent for the API.
 */
const emailFrom =
  process.env.EMAIL_FROM ||
  (process.env.SMTP_USER && !process.env.RESEND_API_KEY
    ? `Salon Management <${process.env.SMTP_USER}>`
    : "Salon Management <onboarding@resend.dev>");

export default {
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
    provider: process.env.EMAIL_PROVIDER || "",
    from: emailFrom,
    resendApiKey: process.env.RESEND_API_KEY || "",
    smtp: {
      host: process.env.SMTP_HOST || "",
      port: Number(process.env.SMTP_PORT) || 587,
      user: process.env.SMTP_USER || "",
      pass: process.env.SMTP_PASS || "",
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
} as Config;
