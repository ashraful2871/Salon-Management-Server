import nodemailer, { Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import config from "../../../config";
import { EmailMessage, EmailProvider, EmailResult } from "./types";

/**
 * Plain SMTP, kept for local development and for anywhere port 587 is actually
 * open. It is the fallback, not the default: a hosted free tier almost always
 * drops outbound SMTP, which is what `ENETUNREACH` and `ETIMEDOUT` in a deploy
 * log mean.
 *
 * Two settings here are the difference between a clean failure and a two-minute
 * hang, and both were learned from that log:
 *
 *   family: 4          - nodemailer resolves A and AAAA records and falls back
 *                        through the list. Hosts without IPv6 egress answer the
 *                        AAAA attempt with ENETUNREACH, so pin IPv4 and skip it.
 *   connectionTimeout  - the default is two minutes. A blocked port should be
 *                        reported in seconds, not tie up a socket that long.
 */
const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

/** One pooled transporter, not one per email as this used to do. */
let transporter: Transporter | null = null;

const getTransporter = () => {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: config.email.smtp.host,
    port: config.email.smtp.port,
    // 465 is implicit TLS; 587 upgrades with STARTTLS.
    secure: config.email.smtp.port === 465,
    auth: {
      user: config.email.smtp.user,
      pass: config.email.smtp.pass,
    },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    // nodemailer passes `family` straight to net.connect, but @types/nodemailer
    // does not declare it - hence the assertion rather than a missing setting.
    family: 4,
  } as SMTPTransport.Options);

  return transporter;
};

export const smtpProvider: EmailProvider = {
  name: "smtp",

  isConfigured: () =>
    Boolean(config.email.smtp.host && config.email.smtp.user),

  async send({ to, subject, html }: EmailMessage): Promise<EmailResult> {
    try {
      const info = await getTransporter().sendMail({
        from: config.email.from,
        to,
        subject,
        html,
      });

      return { ok: true, provider: "smtp", id: info.messageId };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;

      // These two codes are the signature of a host that will not let SMTP out
      // at all, so name the cause rather than leaving a bare errno in the log.
      const hint =
        err?.code === "ETIMEDOUT" || err?.code === "ESOCKET"
          ? " (port 587 appears to be blocked from this host - use an HTTP API provider such as Resend in production)"
          : "";

      return {
        ok: false,
        provider: "smtp",
        error: `${err?.code ?? "ERROR"}: ${err?.message ?? String(error)}${hint}`,
      };
    }
  },
};
