import config from "../../../config";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Cloudflare Turnstile check for the upload ticket. Without a secret the check
 * passes in development (so local testing needs no widget) and fails closed in
 * production. A network error or timeout counts as a failed check.
 */
export const verifyTurnstile = async (
  token: string,
  ip: string,
): Promise<boolean> => {
  const secret = config.hairTryOn.turnstileSecret;
  if (!secret) return config.env !== "production";

  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(5000),
    });
    const result = (await response.json()) as { success?: boolean };
    return result.success === true;
  } catch {
    return false;
  }
};
