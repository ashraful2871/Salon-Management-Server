import config from "../../../config";
import { EmailMessage, EmailProvider, EmailResult } from "./types";

/**
 * Resend over its HTTPS API.
 *
 * The whole point of this provider is the port: it talks to 443, which every
 * host allows, instead of 587, which Render and most other free tiers drop
 * outbound. That is the difference between a receipt arriving in production and
 * an `ETIMEDOUT` in the logs.
 *
 * It uses `fetch` rather than the Resend SDK on purpose - one less dependency
 * to keep current for a single POST.
 */
const ENDPOINT = "https://api.resend.com/emails";

/** Long enough for a slow API, short enough that nothing hangs a background job. */
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;

/**
 * 429 is Resend's rate limit (the free tier allows 2 requests a second, and a
 * booking can fire several emails at once); 5xx is theirs to fix and ours to
 * wait out. Every other status is a request we got wrong, so retrying it would
 * only fail identically.
 */
const isRetryable = (status: number) => status === 429 || status >= 500;

const backoffMs = (attempt: number) => 400 * 2 ** attempt;

const readError = async (response: Response) => {
  try {
    const body = (await response.json()) as { message?: string; name?: string };
    if (body?.message) return body.message;
    if (body?.name) return body.name;
  } catch {
    // A non-JSON body (a gateway's own error page) is still worth reporting.
  }
  return `HTTP ${response.status}`;
};

export const resendProvider: EmailProvider = {
  name: "resend",

  isConfigured: () => Boolean(config.email.resendApiKey),

  async send({ to, subject, html }: EmailMessage): Promise<EmailResult> {
    let lastError = "unknown error";

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.email.resendApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: config.email.from,
            to: [to],
            subject,
            html,
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (response.ok) {
          const body = (await response.json().catch(() => ({}))) as {
            id?: string;
          };
          return { ok: true, provider: "resend", id: body?.id };
        }

        lastError = await readError(response);

        if (!isRetryable(response.status)) {
          return { ok: false, provider: "resend", error: lastError };
        }
      } catch (error) {
        // A timeout or a dropped connection. Worth another go.
        lastError = error instanceof Error ? error.message : String(error);
      }

      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
      }
    }

    return { ok: false, provider: "resend", error: lastError };
  },
};
