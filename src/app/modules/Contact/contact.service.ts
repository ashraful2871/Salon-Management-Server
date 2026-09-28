import { StatusCodes } from "http-status-codes";
import config from "../../../config";
import ApiError from "../../Error/error";
import { sendEmail } from "../../utils/emailSender";
import { escapeHtml } from "../../utils/emailTemplates";
import { ContactMessage } from "./contact.validation";

const row = (label: string, value: string) => `
    <tr>
      <td style="padding:6px 12px 6px 0;color:#7f8c8d;font-size:13px;vertical-align:top;">${label}</td>
      <td style="padding:6px 0;color:#2c3e50;font-size:14px;">${value}</td>
    </tr>`;

/**
 * Forwards a message from the public contact form to CONTACT_INBOX. Every value
 * the visitor typed goes through escapeHtml, so the email can't carry their
 * markup or links.
 */
const sendContactMessage = async (body: ContactMessage, ip: string) => {
  const inbox = config.email.contactInbox?.trim();

  if (!inbox) {
    throw new ApiError(
      StatusCodes.SERVICE_UNAVAILABLE,
      "The contact form isn't available right now. Please email us instead.",
    );
  }

  const name = body.name.trim();
  const email = body.email.trim();
  const subject = body.subject?.trim() ?? "";
  const sentAt = new Date().toLocaleString("en-GB", {
    timeZone: "Asia/Dhaka",
    dateStyle: "medium",
    timeStyle: "short",
  });

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
    <h2 style="margin:0 0 16px;color:#2c3e50;font-size:18px;">New contact form message</h2>
    <table style="border-collapse:collapse;margin-bottom:16px;">
      ${row("Name", escapeHtml(name))}
      ${row("Email", escapeHtml(email))}
      ${row("Subject", escapeHtml(subject || "—"))}
      ${row("Sent", `${escapeHtml(sentAt)} (Asia/Dhaka)`)}
      ${row("IP", escapeHtml(ip))}
    </table>
    <div style="padding:16px;border:1px solid #eef1f3;border-radius:8px;color:#2c3e50;font-size:14px;line-height:1.6;">
      ${escapeHtml(body.message.trim()).replace(/\r?\n/g, "<br>")}
    </div>
    <p style="margin-top:16px;color:#7f8c8d;font-size:12px;">Reply to ${escapeHtml(email)} to answer.</p>
  </div>`;

  const emailSubject = `Contact: ${subject || "New message"} (from ${name})`.replace(
    /[\r\n]+/g,
    " ",
  );

  const result = await sendEmail(inbox, emailSubject, html);

  if (!result.ok) {
    throw new ApiError(
      StatusCodes.BAD_GATEWAY,
      "We couldn't send your message. Please try again or email us.",
    );
  }
};

export const ContactService = {
  sendContactMessage,
};
