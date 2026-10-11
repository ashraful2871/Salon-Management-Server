import config from "../../../config";
import prisma from "../../shared/prisma";
import { sendEmail } from "../../utils/emailSender";
import { escapeHtml } from "../../utils/emailTemplates";
import { ContactMessage } from "./contact.validation";

const row = (label: string, value: string) => `
    <tr>
      <td style="padding:6px 12px 6px 0;color:#7f8c8d;font-size:13px;vertical-align:top;">${label}</td>
      <td style="padding:6px 0;color:#2c3e50;font-size:14px;">${value}</td>
    </tr>`;

/** A booking code quoted anywhere in the message, e.g. "TKN-EYCES". */
const BOOKING_TOKEN = /\bTKN-[A-Z0-9]{4,8}\b/i;

/**
 * Stores a message from the public contact form as a support ticket (its first
 * message is the visitor's text), then forwards it to CONTACT_INBOX when that
 * is set. The ticket is the record: an unset inbox or a failed email still
 * answers success. Every value the visitor typed goes through escapeHtml.
 */
const sendContactMessage = async (body: ContactMessage, ip: string) => {
  const name = body.name.trim();
  const email = body.email.trim();
  const subject = body.subject?.trim() ?? "";
  const message = body.message.trim();

  // Best-effort links for the support inbox; neither is shown to the visitor.
  const token = `${subject} ${message}`.match(BOOKING_TOKEN)?.[0]?.toUpperCase();
  const [user, appointment] = await Promise.all([
    prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true },
    }),
    token ? prisma.appointment.findUnique({ where: { token }, select: { id: true } }) : null,
  ]);

  const ticket = await prisma.supportTicket.create({
    data: {
      source: "CONTACT_FORM",
      name,
      email,
      userId: user?.id ?? null,
      appointmentId: appointment?.id ?? null,
      subject: subject || "New message",
      category: appointment ? "BOOKING" : "OTHER",
      messages: { create: { authorType: "CUSTOMER", authorId: user?.id ?? null, body: message } },
    },
    select: { number: true },
  });

  const inbox = config.email.contactInbox?.trim();
  if (!inbox) return { ticketNumber: ticket.number };

  const sentAt = new Date().toLocaleString("en-GB", {
    timeZone: "Asia/Dhaka",
    dateStyle: "medium",
    timeStyle: "short",
  });

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
    <h2 style="margin:0 0 16px;color:#2c3e50;font-size:18px;">New contact form message (ticket #${ticket.number})</h2>
    <table style="border-collapse:collapse;margin-bottom:16px;">
      ${row("Name", escapeHtml(name))}
      ${row("Email", escapeHtml(email))}
      ${row("Subject", escapeHtml(subject || "—"))}
      ${row("Sent", `${escapeHtml(sentAt)} (Asia/Dhaka)`)}
      ${row("IP", escapeHtml(ip))}
    </table>
    <div style="padding:16px;border:1px solid #eef1f3;border-radius:8px;color:#2c3e50;font-size:14px;line-height:1.6;">
      ${escapeHtml(message).replace(/\r?\n/g, "<br>")}
    </div>
    <p style="margin-top:16px;color:#7f8c8d;font-size:12px;">Answer from the back office (Support → #${ticket.number}) so the reply is tracked.</p>
  </div>`;

  const emailSubject = `[#${ticket.number}] Contact: ${subject || "New message"} (from ${name})`.replace(
    /[\r\n]+/g,
    " ",
  );

  // sendEmail never throws and logs a failure; the ticket is already stored.
  await sendEmail(inbox, emailSubject, html, { replyTo: email });

  return { ticketNumber: ticket.number };
};

export const ContactService = {
  sendContactMessage,
};
