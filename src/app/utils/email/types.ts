/**
 * The seam between "we want to send this email" and "this is how it leaves the
 * building". Everything above it - the templates, the booking flow, the payment
 * receipt - only ever knows `sendEmail`.
 *
 * The seam exists because the transport is a deployment concern, not an
 * application one: SMTP works on a laptop and is blocked outbound on most
 * hosted free tiers, so which provider is right changes with where the process
 * happens to be running.
 */

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
};

export type EmailResult =
  | { ok: true; provider: string; id?: string }
  | { ok: false; provider: string; error: string };

export interface EmailProvider {
  /** Used in logs, in the test script, and nowhere else. */
  readonly name: string;
  /** False when the env vars this provider needs are absent. */
  isConfigured(): boolean;
  /**
   * Never throws. A transport failure is reported, not raised: an email that
   * does not arrive must not take a booking or a payment down with it.
   */
  send(message: EmailMessage): Promise<EmailResult>;
}
