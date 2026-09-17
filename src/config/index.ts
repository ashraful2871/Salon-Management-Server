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
}
//

const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
const apiUrl = process.env.API_URL || "http://localhost:5000";

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
