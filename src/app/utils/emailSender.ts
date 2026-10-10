import config from "../../config";
import { keyFingerprint, resendProvider } from "./email/resend.provider";
import { smtpProvider } from "./email/smtp.provider";
import { EmailProvider, EmailResult } from "./email/types";

/**
 * The one way mail leaves this application.
 *
 * `sendEmail(to, subject, html)` is unchanged from when this file wrapped
 * nodemailer directly - every template and every caller works as before. What
 * changed is underneath: the transport is chosen from the environment, because
 * SMTP is fine on a laptop and blocked outbound on most hosted free tiers.
 */

const PROVIDERS: EmailProvider[] = [resendProvider, smtpProvider];

const byName = (name: string) =>
  PROVIDERS.find((provider) => provider.name === name);

/**
 * `EMAIL_PROVIDER` wins when it is set, so a deploy can be pinned explicitly.
 * Otherwise take the first provider that has its credentials - which puts the
 * HTTPS one ahead of SMTP, the order that works in the most places.
 */
const selectProvider = (): EmailProvider | null => {
  const requested = config.email.provider?.trim().toLowerCase();

  if (requested && requested !== "auto") {
    const provider = byName(requested);

    if (!provider) {
      console.error(
        `[email] EMAIL_PROVIDER="${requested}" is not a provider. Known: ${PROVIDERS.map((p) => p.name).join(", ")}`,
      );
      return null;
    }

    if (!provider.isConfigured()) {
      console.error(
        `[email] EMAIL_PROVIDER="${requested}" is selected but not configured. Nothing will be sent.`,
      );
      return null;
    }

    return provider;
  }

  return PROVIDERS.find((provider) => provider.isConfigured()) ?? null;
};

let resolved: EmailProvider | null | undefined;

/** Resolved once: the environment does not change while the process runs. */
const activeProvider = () => {
  if (resolved === undefined) {
    resolved = selectProvider();

    if (resolved) {
      console.log(
        `[email] sending through ${resolved.name} as ${config.email.from}${
          resolved.name === "resend" ? ` with key ${keyFingerprint()}` : ""
        }`,
      );

      // Said at boot rather than on the first send, because a key of the wrong
      // shape is a deploy mistake and the person who can fix it is watching the
      // deploy log, not the wallet top-up that fails an hour later.
      if (
        resolved.name === "resend" &&
        !config.email.resendApiKey.startsWith("re_")
      ) {
        console.error(
          `[email] RESEND_API_KEY does not start with "re_" - that is not a Resend API key. Check the value on the host; a truncated paste or the wrong variable pasted in will be rejected as "API key is invalid".`,
        );
      }

      const fromAddress = config.email.from.match(/<([^>]+)>/)?.[1] ?? config.email.from;

      if (resolved.name === "resend" && fromAddress.endsWith("@resend.dev")) {
        console.warn(
          `[email] sending from ${fromAddress} - Resend's shared test sender only delivers to the address that owns the Resend account. Set EMAIL_FROM to an address on your verified domain.`,
        );
      }
    } else {
      console.error(
        "[email] no email provider is configured - set RESEND_API_KEY (recommended) or the SMTP_* variables. Emails will be skipped.",
      );
    }
  }

  return resolved;
};

/** Exposed for the test script and for startup diagnostics. */
export const getEmailProviderName = () => activeProvider()?.name ?? "none";

// Failed sends in this process over the last day, for the admin System page.
// Per process and lost on restart: a rough signal, not a delivery log.
const DAY_MS = 24 * 60 * 60 * 1000;
const failures: Array<{ at: number; error: string }> = [];
let sentSinceBoot = 0;

const noteEmailFailure = (error: string) => {
  const cutoff = Date.now() - DAY_MS;
  while (failures.length && failures[0].at < cutoff) failures.shift();
  failures.push({ at: Date.now(), error: error.slice(0, 200) });
  if (failures.length > 500) failures.shift();
};

/** Read-only view for `GET /admin/system/integrations`. */
export const emailHealth = () => {
  const cutoff = Date.now() - DAY_MS;
  const recent = failures.filter((f) => f.at >= cutoff);
  const last = recent[recent.length - 1];
  return {
    provider: getEmailProviderName(),
    failures24h: recent.length,
    sentSinceBoot,
    lastFailureAt: last ? new Date(last.at) : null,
    lastError: last?.error ?? null,
  };
};

/**
 * Domains reserved by RFC 2606 / 6761 that can never receive mail. The seeded
 * test customers and staff (`npm run seed:dhaka`) live on example.com, so a
 * reminder or a cancellation for one of their bookings is dropped here rather
 * than spending provider quota on a guaranteed bounce.
 */
const UNDELIVERABLE_DOMAIN =
  /@(?:[^@\s]+\.)?(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i;

/**
 * Sends one email and never throws: a receipt that cannot be delivered must not
 * roll back the payment that earned it. Failures are logged loudly and returned,
 * so a caller that does care can check.
 */
export const sendEmail = async (
  to: string,
  subject: string,
  html: string,
  opts: { replyTo?: string } = {},
): Promise<EmailResult> => {
  if (UNDELIVERABLE_DOMAIN.test(to.trim())) {
    console.log(`[email] skipped "${subject}" to ${to}: reserved test domain`);
    return { ok: false, provider: "none", error: "Reserved test domain, not sent" };
  }

  const provider = activeProvider();

  if (!provider) {
    noteEmailFailure("No email provider configured");
    return { ok: false, provider: "none", error: "No email provider configured" };
  }

  const result = await provider.send({ to, subject, html, replyTo: opts.replyTo });

  if (result.ok) {
    sentSinceBoot += 1;
    console.log(
      `[email] sent "${subject}" to ${to} via ${result.provider}${result.id ? ` (${result.id})` : ""}`,
    );
  } else {
    // Loud on purpose. The old version swallowed this, which is why a silent
    // production outage looked like "the email just never arrives".
    noteEmailFailure(result.error ?? "Unknown error");
    console.error(
      `[email] FAILED to send "${subject}" to ${to} via ${result.provider}: ${result.error}`,
    );
  }

  return result;
};
