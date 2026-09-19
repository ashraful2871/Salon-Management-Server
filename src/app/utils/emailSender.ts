import config from "../../config";
import { resendProvider } from "./email/resend.provider";
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
      console.log(`[email] sending through ${resolved.name} as ${config.email.from}`);
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

/**
 * Sends one email and never throws: a receipt that cannot be delivered must not
 * roll back the payment that earned it. Failures are logged loudly and returned,
 * so a caller that does care can check.
 */
export const sendEmail = async (
  to: string,
  subject: string,
  html: string,
): Promise<EmailResult> => {
  const provider = activeProvider();

  if (!provider) {
    return { ok: false, provider: "none", error: "No email provider configured" };
  }

  const result = await provider.send({ to, subject, html });

  if (result.ok) {
    console.log(
      `[email] sent "${subject}" to ${to} via ${result.provider}${result.id ? ` (${result.id})` : ""}`,
    );
  } else {
    // Loud on purpose. The old version swallowed this, which is why a silent
    // production outage looked like "the email just never arrives".
    console.error(
      `[email] FAILED to send "${subject}" to ${to} via ${result.provider}: ${result.error}`,
    );
  }

  return result;
};
