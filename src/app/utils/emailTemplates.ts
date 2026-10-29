import config from "../../config";
import { SITE_NAME } from "./brand";
export const getBookingConfirmationTemplate = (
  customerName: string,
  salonName: string,
  serviceName: string,
  date: string,
  time: string,
  price: string,
  // Trailing and optional so the six positional arguments above keep their
  // meaning. Bookings made before tokens existed simply have none.
  identity?: {
    token?: string | null;
    serialNumber?: number | null;
    staffName?: string | null;
    counterName?: string | null;
  }
) => {
  const token = identity?.token;
  const serialNumber = identity?.serialNumber;
  // A serial only means something within its queue - salon + service +
  // counter + day - so it is always shown with the queue it belongs to.
  const serialQueue = [serviceName, identity?.counterName]
    .filter(Boolean)
    .join(" · ");

  // The one thing the customer has to have at the counter, so it gets its own
  // block above the details rather than a row inside them. Tables and inline
  // styles throughout: Gmail and Outlook drop flexbox and most of a <style>.
  const identityBlock =
    token || serialNumber != null
      ? `
        <div class="token-card" style="background-color: #2c3e50; color: #ffffff; border-radius: 6px; padding: 20px 16px 12px; margin: 25px 0; text-align: center;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              ${
                serialNumber != null
                  ? `<td style="text-align: center; padding: 4px 8px;">
                      <div class="token-label" style="font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: #a9b7c6; margin-bottom: 6px;">Your place in line</div>
                      <div class="token-serial" style="font-size: 30px; font-weight: 700; line-height: 1.1; color: #ffffff;">Serial #${serialNumber}</div>
                      <div class="token-queue" style="font-size: 13px; line-height: 1.4; color: #d5dde6; margin-top: 4px;">${serialQueue}</div>
                    </td>`
                  : ""
              }
              ${
                token
                  ? `<td style="text-align: center; padding: 4px 8px;">
                      <div class="token-label" style="font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: #a9b7c6; margin-bottom: 6px;">Booking token</div>
                      <div class="token-code" style="font-family: 'Courier New', Courier, monospace; font-size: 24px; font-weight: 700; letter-spacing: 3px; line-height: 1.2; color: #ffffff;">${token}</div>
                    </td>`
                  : ""
              }
            </tr>
          </table>
          <p class="token-hint" style="font-size: 12px; color: #a9b7c6; margin: 14px 0 0;">
            Show this${token ? " token" : ""} at the salon counter${
              serialNumber != null
                ? " - your serial is the order you will be called in for this service and counter"
                : ""
            }.
          </p>
        </div>`
      : "";

  const extraRows = `${
    identity?.staffName
      ? `<tr>
          <td class="detail-label" style="padding: 5px 0;">Stylist</td>
          <td class="detail-value" style="padding: 5px 0;">${identity.staffName}</td>
        </tr>`
      : ""
  }${
    identity?.counterName
      ? `<tr>
          <td class="detail-label" style="padding: 5px 0;">Counter</td>
          <td class="detail-value" style="padding: 5px 0;">${identity.counterName}</td>
        </tr>`
      : ""
  }`;

  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Booking Confirmation</title>
    <style>
      body {
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        line-height: 1.6;
        color: #333333;
        background-color: #f4f7f6;
        margin: 0;
        padding: 0;
      }
      .container {
        max-width: 600px;
        margin: 40px auto;
        background-color: #ffffff;
        border-radius: 8px;
        overflow: hidden;
        box-shadow: 0 4px 15px rgba(0, 0, 0, 0.05);
      }
      .header {
        background-color: #2c3e50;
        color: #ffffff;
        padding: 30px 20px;
        text-align: center;
      }
      .header h1 {
        margin: 0;
        font-size: 24px;
        font-weight: 600;
        letter-spacing: 1px;
      }
      .content {
        padding: 40px 30px;
      }
      .greeting {
        font-size: 18px;
        margin-bottom: 20px;
      }
      .booking-details {
        background-color: #f8f9fa;
        border-left: 4px solid #3498db;
        padding: 20px;
        margin: 25px 0;
        border-radius: 0 4px 4px 0;
      }
      .detail-row {
        display: flex;
        margin-bottom: 10px;
      }
      .detail-label {
        font-weight: 600;
        width: 120px;
        color: #555555;
      }
      .detail-value {
        color: #222222;
        font-weight: 500;
      }
      .footer {
        text-align: center;
        padding: 20px;
        font-size: 14px;
        color: #888888;
        background-color: #fdfdfd;
        border-top: 1px solid #eeeeee;
      }
      .button {
        display: inline-block;
        padding: 12px 24px;
        background-color: #3498db;
        color: #ffffff;
        text-decoration: none;
        border-radius: 4px;
        font-weight: 600;
        margin-top: 20px;
      }
      .token-card {
        background-color: #2c3e50;
        color: #ffffff;
        border-radius: 6px;
        padding: 20px 16px 12px;
        margin: 25px 0;
        text-align: center;
      }
      .token-label {
        font-size: 11px;
        letter-spacing: 1.5px;
        text-transform: uppercase;
        color: #a9b7c6;
        margin-bottom: 6px;
      }
      .token-serial {
        font-size: 30px;
        font-weight: 700;
        line-height: 1.1;
        color: #ffffff;
      }
      .token-code {
        font-family: 'Courier New', Courier, monospace;
        font-size: 24px;
        font-weight: 700;
        letter-spacing: 3px;
        line-height: 1.2;
        color: #ffffff;
      }
      .token-hint {
        font-size: 12px;
        color: #a9b7c6;
        margin: 14px 0 0;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>Appointment Confirmed</h1>
      </div>
      <div class="content">
        <div class="greeting">Hi ${customerName},</div>
        <p>Your appointment at <strong>${salonName}</strong> has been confirmed. Here are your booking details:</p>

        ${identityBlock}

        <div class="booking-details">
          <table style="width: 100%; border-collapse: collapse;">
            ${
              token
                ? `<tr>
              <td class="detail-label" style="padding: 5px 0;">Token</td>
              <td class="detail-value" style="padding: 5px 0;">${token}</td>
            </tr>`
                : ""
            }
            ${
              serialNumber != null
                ? `<tr>
              <td class="detail-label" style="padding: 5px 0;">Serial</td>
              <td class="detail-value" style="padding: 5px 0;">#${serialNumber}</td>
            </tr>`
                : ""
            }
            <tr>
              <td class="detail-label" style="padding: 5px 0;">Salon</td>
              <td class="detail-value" style="padding: 5px 0;">${salonName}</td>
            </tr>
            <tr>
              <td class="detail-label" style="padding: 5px 0;">Service</td>
              <td class="detail-value" style="padding: 5px 0;">${serviceName}</td>
            </tr>
            <tr>
              <td class="detail-label" style="padding: 5px 0;">Date</td>
              <td class="detail-value" style="padding: 5px 0;">${date}</td>
            </tr>
            <tr>
              <td class="detail-label" style="padding: 5px 0;">Time</td>
              <td class="detail-value" style="padding: 5px 0;">${time}</td>
            </tr>
            ${extraRows}
            <tr>
              <td class="detail-label" style="padding: 5px 0;">Price</td>
              <td class="detail-value" style="padding: 5px 0;">${price}</td>
            </tr>
          </table>
        </div>

        <p>We look forward to seeing you!</p>
        <p>If you need to reschedule or cancel your appointment, please contact the salon or use our platform.</p>
      </div>
      <div class="footer">
        <p>&copy; ${new Date().getFullYear()} ${SITE_NAME}. All rights reserved.</p>
      </div>
    </div>
  </body>
  </html>
  `;
};

const baseLayout = (
  heading: string,
  body: string,
  ctaLabel: string,
  ctaUrl: string,
  footerNote: string
) => `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${heading}</title>
    <style>
      body {
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        line-height: 1.6;
        color: #333333;
        background-color: #f4f7f6;
        margin: 0;
        padding: 0;
      }
      .container {
        max-width: 600px;
        margin: 40px auto;
        background-color: #ffffff;
        border-radius: 8px;
        overflow: hidden;
        box-shadow: 0 4px 15px rgba(0, 0, 0, 0.05);
      }
      .header {
        background-color: #2c3e50;
        color: #ffffff;
        padding: 30px 20px;
        text-align: center;
      }
      .header h1 {
        margin: 0;
        font-size: 24px;
        font-weight: 600;
        letter-spacing: 1px;
      }
      .content {
        padding: 40px 30px;
      }
      .button {
        display: inline-block;
        padding: 12px 24px;
        background-color: #3498db;
        color: #ffffff;
        text-decoration: none;
        border-radius: 4px;
        font-weight: 600;
        margin: 20px 0;
      }
      .fallback {
        word-break: break-all;
        font-size: 13px;
        color: #555555;
        background-color: #f8f9fa;
        border-left: 4px solid #3498db;
        padding: 12px 16px;
        border-radius: 0 4px 4px 0;
      }
      .footer {
        text-align: center;
        padding: 20px;
        font-size: 14px;
        color: #888888;
        background-color: #fdfdfd;
        border-top: 1px solid #eeeeee;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>${heading}</h1>
      </div>
      <div class="content">
        ${body}
        <p style="text-align:center;">
          <a class="button" href="${ctaUrl}">${ctaLabel}</a>
        </p>
        <p style="font-size:14px;color:#555555;">
          If the button does not work, copy and paste this link into your browser:
        </p>
        <p class="fallback">${ctaUrl}</p>
      </div>
      <div class="footer">
        ${footerNote}
      </div>
    </div>
  </body>
  </html>
`;

export const getPasswordResetTemplate = (
  userName: string,
  resetUrl: string,
  expiresInMinutes: number
) =>
  baseLayout(
    "Reset Your Password",
    `
      <p style="font-size:18px;">Hi ${userName},</p>
      <p>We received a request to reset the password for your ${SITE_NAME} account.
      Click the button below to choose a new one.</p>
      <p><strong>This link expires in ${expiresInMinutes} minutes and can only be used once.</strong></p>
    `,
    "Reset Password",
    resetUrl,
    "If you did not request a password reset, you can safely ignore this email — your password will not change."
  );

/**
 * The 6-digit code for sign-up and for a new email address. Same look as the other account emails, but with no
 * link or button at all: the code is typed into the page that asked for it, and
 * a mail that only ever carries a code gives a phisher nothing to imitate.
 * Tables and inline styles only, so clients that strip <style> render it too.
 */
export const getOtpEmailTemplate = (
  userName: string,
  code: string,
  expiresInMinutes: number
) => `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your verification code</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f4f7f6;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;line-height:1.6;color:#333333;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f7f6;">
      <tr>
        <td align="center" style="padding:40px 12px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 4px 15px rgba(0,0,0,0.05);">
            <tr>
              <td align="center" style="background-color:#2c3e50;color:#ffffff;padding:30px 20px;">
                <h1 style="margin:0;font-size:24px;font-weight:600;letter-spacing:1px;color:#ffffff;">Your verification code</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:40px 30px;">
                <p style="margin:0 0 16px;font-size:18px;">Hi ${escapeHtml(userName)},</p>
                <p style="margin:0 0 24px;">Enter this code on ${SITE_NAME} to confirm your email address:</p>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 24px;">
                  <tr>
                    <td align="center" style="background-color:#f8f9fa;border:1px solid #e1e5e8;border-radius:6px;padding:16px 28px;font-family:'Courier New',Courier,monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:#2c3e50;">${code}</td>
                  </tr>
                </table>
                <p style="margin:0 0 12px;"><strong>It expires in ${expiresInMinutes} minutes.</strong></p>
                <p style="margin:0;">Never share this code. ${SITE_NAME} will never ask you for it.</p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:20px;font-size:14px;color:#888888;background-color:#fdfdfd;border-top:1px solid #eeeeee;">
                Didn't try to sign up? You can ignore this email.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
`;

const moneyLayout = (heading: string, body: string) => `
  <!DOCTYPE html>
  <html>
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
  <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333333; background-color: #f4f7f6; margin: 0; padding: 0;">
    <div style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
      <div style="background-color: #2c3e50; color: #ffffff; padding: 30px 20px; text-align: center;">
        <h1 style="margin: 0; font-size: 22px;">${heading}</h1>
      </div>
      <div style="padding: 30px 25px;">${body}</div>
      <div style="background-color: #f4f7f6; padding: 18px; text-align: center; font-size: 12px; color: #7f8c8d;">
        ${SITE_NAME}
      </div>
    </div>
  </body>
  </html>
`;

/**
 * The top-up receipt. This is the customer's proof of payment, so every field
 * they might have to quote to support belongs on it - above all the
 * transaction id, which is the same string the wallet page shows and the only
 * handle either side has on a gateway payment.
 */
export const getWalletTopupInvoiceTemplate = (invoice: {
  customerName: string;
  transactionId: string;
  amount: string;
  availableBalance: string;
  method: string;
  gatewayRef: string | null;
  paidAt: Date;
  provider: string;
}) => {
  const paidAt = invoice.paidAt.toLocaleString("en-GB", {
    timeZone: "Asia/Dhaka",
    dateStyle: "medium",
    timeStyle: "short",
  });

  const row = (label: string, value: string, mono = false) => `
    <tr>
      <td style="padding:10px 0;color:#7f8c8d;font-size:13px;border-bottom:1px solid #eef1f3;">${label}</td>
      <td style="padding:10px 0;text-align:right;font-size:13px;color:#2c3e50;border-bottom:1px solid #eef1f3;${
        mono ? "font-family:'Courier New',monospace;word-break:break-all;" : ""
      }">${value}</td>
    </tr>`;

  return moneyLayout(
    "Payment receipt",
    `<p>Hi ${invoice.customerName},</p>
     <p>We have received your payment. <strong>${invoice.amount}</strong> has been added to your wallet.</p>

     <div style="background:#f8f9fa;border:1px solid #e8ecef;border-radius:6px;padding:18px 20px;margin:22px 0;">
       <p style="margin:0 0 6px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#7f8c8d;">Amount paid</p>
       <p style="margin:0;font-size:28px;font-weight:bold;color:#27ae60;">${invoice.amount}</p>
     </div>

     <table style="width:100%;border-collapse:collapse;border-top:1px solid #eef1f3;">
       ${row("Transaction ID", invoice.transactionId, true)}
       ${row("Gateway reference", invoice.gatewayRef || "&mdash;", true)}
       ${row("Payment method", invoice.method)}
       ${row("Paid via", invoice.provider)}
       ${row("Date", paidAt)}
       ${row("Status", '<span style="color:#27ae60;font-weight:bold;">PAID</span>')}
       ${row("Available balance", `<strong>${invoice.availableBalance}</strong>`)}
     </table>

     <p style="color:#7f8c8d;font-size:13px;margin-top:22px;">Keep the transaction ID &mdash; it is what support needs to trace this payment. Your balance is used to hold booking deposits; nothing is charged until you complete or miss an appointment.</p>`
  );
};

export const getDepositReleasedTemplate = (
  customerName: string,
  amount: string,
  salonName: string
) =>
  moneyLayout(
    "Deposit returned",
    `<p>Hi ${customerName},</p>
     <p><strong>${amount}</strong> has been returned to your wallet for your cancelled booking at ${salonName}.</p>
     <p style="color:#7f8c8d;font-size:13px;">It is available to spend straight away.</p>`
  );

export const getDepositForfeitedTemplate = (
  customerName: string,
  amount: string,
  salonName: string
) =>
  moneyLayout(
    "Deposit forfeited",
    `<p>Hi ${customerName},</p>
     <p>Your booking at ${salonName} was marked as a no-show, and the <strong>${amount}</strong> deposit has been forfeited.</p>
     <p>Think this is wrong? You can appeal within <strong>48 hours</strong> from your bookings page and an admin will review it.</p>`
  );

/** A no-show appeal (or an admin's reversal) was decided. `note` is escaped here. */
export const getAppealResolvedTemplate = (
  customerName: string,
  salonName: string,
  outcome: { approve: boolean; amount: string; refunded: boolean; note?: string }
) =>
  moneyLayout(
    outcome.approve ? "Appeal upheld" : "Appeal not upheld",
    outcome.approve
      ? `<p>Hi ${escapeHtml(customerName)},</p>
     <p>We reviewed the no-show on your booking at ${escapeHtml(salonName)} and reversed it.${
       outcome.refunded ? ` <strong>${outcome.amount}</strong> has been returned to your wallet.` : ""
     }</p>
     <p style="color:#7f8c8d;font-size:13px;">Sorry for the trouble.</p>`
      : `<p>Hi ${escapeHtml(customerName)},</p>
     <p>We reviewed your appeal about the no-show at ${escapeHtml(salonName)}, and the no-show stands, so the deposit stays forfeited.</p>${
       outcome.note ? `<p><strong>Our note:</strong> ${escapeHtml(outcome.note)}</p>` : ""
     }
     <p style="color:#7f8c8d;font-size:13px;">If something is still not right, reply to this email.</p>`
  );

/** A payout to a salon was sent (PAID) or bounced (FAILED). */
export const getPayoutUpdateTemplate = (
  ownerName: string,
  salonName: string,
  payout: {
    paid: boolean;
    amount: string;
    method?: string | null;
    reference?: string | null;
    failureReason?: string | null;
    /** "bKash ••• 4821", from the payout's destination snapshot. */
    destination?: string | null;
    /** The owner's payout settings page, linked from a failure. */
    settingsUrl?: string;
  }
) =>
  moneyLayout(
    payout.paid ? "Payout sent" : "Payout failed",
    payout.paid
      ? `<p>Hi ${escapeHtml(ownerName)},</p>
     <p><strong>${payout.amount}</strong> sent to ${
       payout.destination
         ? escapeHtml(payout.destination)
         : `${escapeHtml(salonName)}${payout.method ? ` by ${escapeHtml(payout.method === "BKASH" ? "bKash" : "bank transfer")}` : ""}`
     }${payout.reference ? `, reference <strong>${escapeHtml(payout.reference)}</strong>` : ""}.</p>
     <p style="color:#7f8c8d;font-size:13px;">The bookings behind it are on your Earnings page.</p>`
      : `<p>Hi ${escapeHtml(ownerName)},</p>
     <p>Our transfer of <strong>${payout.amount}</strong> to ${escapeHtml(payout.destination ?? salonName)} did not go through.${
       payout.failureReason ? ` Reason: ${escapeHtml(payout.failureReason)}.` : ""
     }</p>
     <p>Nothing is lost: the money is back in your balance and will be sent with your next payout.</p>
     <p>${
       payout.settingsUrl
         ? `<a href="${escapeHtml(payout.settingsUrl)}">Fix your payout account</a> if its details are wrong.`
         : "Please check your payout details."
     }</p>`
  );

/** The weekly batch raised a payout for this business. */
export const getPayoutPreparedTemplate = (notice: {
  ownerName: string;
  amount: string;
  destination: string | null;
  expectedBy: string;
}) =>
  moneyLayout(
    "Your payout is being prepared",
    `<p>Hi ${escapeHtml(notice.ownerName)},</p>
     <p>A payout of <strong>${escapeHtml(notice.amount)}</strong> is being prepared${
       notice.destination ? ` for ${escapeHtml(notice.destination)}` : ""
     }, expected by <strong>${escapeHtml(notice.expectedBy)}</strong>.</p>
     <p style="color:#7f8c8d;font-size:13px;">We email you again with the transfer reference once it is sent.</p>`
  );

/** The weekly batch's summary for Finance. */
export const getPayoutBatchSummaryTemplate = (summary: {
  week: string;
  count: number;
  total: string;
  skipped: { reason: string; count: number }[];
  url: string;
}) =>
  moneyLayout(
    "Weekly payouts raised",
    `<p>The payout batch for the week of <strong>${escapeHtml(summary.week)}</strong> ran.</p>
     <p><strong>${summary.count}</strong> payout(s), <strong>${escapeHtml(summary.total)}</strong> in total, are waiting for approval.</p>${
       summary.skipped.length
         ? `<p>Skipped:</p><ul>${summary.skipped.map((s) => `<li>${escapeHtml(s.reason)}: ${s.count}</li>`).join("")}</ul>`
         : ""
     }
     <p><a href="${escapeHtml(summary.url)}">Open payouts</a></p>`
  );

/**
 * Sent to the owner's sign-in email and the business email when a payout
 * account is added. A hijacked account redirecting payouts is the attack this
 * warns about, so it goes to every address we have.
 */
export const getPayoutAccountAddedTemplate = (notice: {
  ownerName: string;
  account: string;
  cooldownHours: number | null;
  contactUrl: string;
}) =>
  moneyLayout(
    "A payout account was added",
    `<p>Hi ${escapeHtml(notice.ownerName)},</p>
     <p>A new payout account was added to your ${SITE_NAME} business: <strong>${escapeHtml(notice.account)}</strong>.</p>
     <p>Our finance team checks every new account before money is sent to it.${
       notice.cooldownHours
         ? ` Payouts keep going to your current account for at least ${notice.cooldownHours} hours.`
         : ""
     }</p>
     <p style="color:#c0392b;font-size:13px;">If this wasn't you, <a href="${escapeHtml(notice.contactUrl)}">contact us</a> straight away and change your password - someone may be trying to redirect your payouts.</p>`
  );

/** Finance verified or rejected a payout account. */
export const getPayoutAccountDecisionTemplate = (notice: {
  ownerName: string;
  account: string;
  verified: boolean;
  reason?: string | null;
  settingsUrl: string;
}) =>
  moneyLayout(
    notice.verified ? "Payout account verified" : "Payout account not approved",
    notice.verified
      ? `<p>Hi ${escapeHtml(notice.ownerName)},</p>
     <p>Your payout account <strong>${escapeHtml(notice.account)}</strong> is verified. Future payouts go to it.</p>`
      : `<p>Hi ${escapeHtml(notice.ownerName)},</p>
     <p>We could not verify your payout account <strong>${escapeHtml(notice.account)}</strong>.</p>
     ${notice.reason ? `<p><strong>Reason:</strong> ${escapeHtml(notice.reason)}</p>` : ""}
     <p>You can <a href="${escapeHtml(notice.settingsUrl)}">add the account again</a> with the details corrected.</p>`
  );

/** Finance verified or rejected the business's KYC details. */
export const getKycDecisionTemplate = (notice: {
  ownerName: string;
  verified: boolean;
  reason?: string | null;
  settingsUrl: string;
}) =>
  moneyLayout(
    notice.verified ? "Business details verified" : "Business details need changes",
    notice.verified
      ? `<p>Hi ${escapeHtml(notice.ownerName)},</p>
     <p>Your business details (legal name, trade licence and tax numbers) are verified.</p>`
      : `<p>Hi ${escapeHtml(notice.ownerName)},</p>
     <p>We could not verify your business details.</p>
     ${notice.reason ? `<p><strong>Reason:</strong> ${escapeHtml(notice.reason)}</p>` : ""}
     <p>Please <a href="${escapeHtml(notice.settingsUrl)}">update them</a> and submit again.</p>`
  );

/** Another admin asked for a second pair of eyes on a money move. */
export const getApprovalRequestTemplate = (
  requesterName: string,
  summary: string,
  reason: string,
  url: string
) =>
  moneyLayout(
    "Approval needed",
    `<p>${escapeHtml(requesterName)} asked for approval:</p>
     <p><strong>${escapeHtml(summary)}</strong></p>
     <p>Reason: ${escapeHtml(reason)}</p>
     <p><a href="${url}" style="color:#2c3e50;font-weight:bold;">Review it in the back office</a>. It expires in 24 hours.</p>`
  );

// For text a customer typed, such as their name. It lands in the salon owner's
// inbox, so it must not be able to add links or markup of its own.
export const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * Tells a salon owner that a customer has just booked. Laid out for the
 * counter: the serial and token are what the customer will give on arrival,
 * and the amount due is what is left to collect once the deposit is counted.
 */
export const getNewBookingOwnerTemplate = (booking: {
  ownerName: string;
  salonName: string;
  customerName: string;
  serviceName: string;
  counterName?: string | null;
  serialNumber?: number | null;
  token?: string | null;
  date: string;
  time: string;
  dueAtCounter: string;
}) => {
  const row = (label: string, value: string, mono = false) => `
    <tr>
      <td style="padding:10px 0;color:#7f8c8d;font-size:13px;border-bottom:1px solid #eef1f3;">${label}</td>
      <td style="padding:10px 0;text-align:right;font-size:13px;color:#2c3e50;border-bottom:1px solid #eef1f3;${
        mono ? "font-family:'Courier New',monospace;" : ""
      }">${value}</td>
    </tr>`;

  const serial = booking.serialNumber ? `#${booking.serialNumber}` : "&mdash;";

  return moneyLayout(
    "New booking",
    `<p>Hi ${escapeHtml(booking.ownerName)},</p>
     <p><strong>${escapeHtml(booking.customerName)}</strong> has booked ${escapeHtml(booking.serviceName)} at ${escapeHtml(booking.salonName)}.</p>

     <div style="background:#f8f9fa;border:1px solid #e8ecef;border-radius:6px;padding:18px 20px;margin:22px 0;">
       <p style="margin:0 0 6px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#7f8c8d;">Serial</p>
       <p style="margin:0;font-size:28px;font-weight:bold;color:#2c3e50;">${serial}</p>
     </div>

     <table style="width:100%;border-collapse:collapse;border-top:1px solid #eef1f3;">
       ${row("Customer", escapeHtml(booking.customerName))}
       ${row("Service", escapeHtml(booking.serviceName))}
       ${row("Counter", booking.counterName ? escapeHtml(booking.counterName) : "&mdash;")}
       ${row("Date", booking.date)}
       ${row("Time", booking.time)}
       ${row("Token", booking.token || "&mdash;", true)}
       ${row("Due at the counter", `<strong>${booking.dueAtCounter}</strong>`)}
     </table>`
  );
};

/**
 * Sent to the address an account just moved away from. If the owner did not
 * make the change, this is the only warning they get - the new address now
 * receives every password reset, so it has to reach the old inbox.
 */
export const getEmailChangedNoticeTemplate = (
  userName: string,
  newEmail: string
) =>
  moneyLayout(
    "Your email was changed",
    `<p>Hi ${escapeHtml(userName)},</p>
     <p>The email address on your ${SITE_NAME} account was just changed to <strong>${escapeHtml(newEmail)}</strong>.</p>
     <p>From now on, sign in with the new address. Booking confirmations, receipts and password reset links will be sent there instead of here.</p>
     <p style="color:#c0392b;font-size:13px;">If you did not make this change, please contact support straight away - someone may have access to your account.</p>`
  );

/**
 * Sent when a Google account is linked to an existing, verified account. From
 * then on that Google login opens this account, so the owner has to hear of it.
 */
export const getGoogleLinkedNoticeTemplate = (userName: string) =>
  moneyLayout(
    "Google sign-in was added",
    `<p>Hi ${escapeHtml(userName)},</p>
     <p>Google sign-in was added to your ${SITE_NAME} account. You can now sign in with Google as well as with your password.</p>
     <p style="color:#c0392b;font-size:13px;">If this wasn't you, reset your password and contact support.</p>
     <p style="color:#7f8c8d;font-size:12px;">${SITE_NAME} - ${new URL(config.frontend_url).host}</p>`
  );

/**
 * The 24-hour and 2-hour booking reminders. Everything the customer needs at
 * the counter (token, serial, what is left to pay) plus the one thing that
 * costs money if they forget it: when free cancellation closes.
 */
export const getBookingReminderTemplate = (reminder: {
  customerName: string;
  when: "tomorrow" | "in 2 hours";
  salonName: string;
  salonAddress: string;
  salonPhone: string;
  serviceName: string;
  date: string;
  time: string;
  token: string | null;
  serialNumber: number | null;
  dueAtSalon: string;
  /** Sentence about the cancellation deadline, already worded. */
  cancellation: string;
  manageUrl: string;
}) => {
  const row = (label: string, value: string, mono = false) => `
    <tr>
      <td style="padding:10px 0;color:#7f8c8d;font-size:13px;border-bottom:1px solid #eef1f3;">${label}</td>
      <td style="padding:10px 0;text-align:right;font-size:13px;color:#2c3e50;border-bottom:1px solid #eef1f3;${
        mono ? "font-family:'Courier New',monospace;" : ""
      }">${value}</td>
    </tr>`;

  return moneyLayout(
    reminder.when === "tomorrow"
      ? "Your appointment is tomorrow"
      : "Your appointment is in 2 hours",
    `<p>Hi ${escapeHtml(reminder.customerName)},</p>
     <p>A reminder of your <strong>${escapeHtml(reminder.serviceName)}</strong> at <strong>${escapeHtml(reminder.salonName)}</strong>, ${reminder.when}.</p>

     <table style="width:100%;border-collapse:collapse;border-top:1px solid #eef1f3;margin:18px 0;">
       ${row("Date", reminder.date)}
       ${row("Time", reminder.time)}
       ${reminder.token ? row("Token", `<strong>${reminder.token}</strong>`, true) : ""}
       ${reminder.serialNumber ? row("Serial", `#${reminder.serialNumber}`) : ""}
       ${row("Pay at the salon", `<strong>${reminder.dueAtSalon}</strong>`)}
       ${row("Address", escapeHtml(reminder.salonAddress))}
       ${row("Phone", escapeHtml(reminder.salonPhone))}
     </table>

     <p style="font-size:14px;">${reminder.cancellation}</p>
     <p style="text-align:center;margin:24px 0;">
       <a href="${reminder.manageUrl}" style="display:inline-block;padding:12px 24px;background-color:#2c3e50;color:#ffffff;text-decoration:none;border-radius:4px;font-weight:600;">Manage booking</a>
     </p>
     <p style="color:#7f8c8d;font-size:13px;">Show your token at the counter when you arrive.</p>`
  );
};

/**
 * An invitation to join the back office as an admin or an area agent. The
 * link carries the only copy of the token; accepting needs a signed-in,
 * verified account on this same address.
 */
export const getAdminInvitationTemplate = (invite: {
  name?: string | null;
  inviterName: string;
  roleLabel: string;
  link: string;
  expiresAt: Date;
}) =>
  moneyLayout(
    `You are invited to the ${SITE_NAME} team`,
    `<p>Hi ${escapeHtml(invite.name || "there")},</p>
     <p>${escapeHtml(invite.inviterName)} invited you to join ${SITE_NAME} as <strong>${escapeHtml(invite.roleLabel)}</strong>.</p>
     <p><a href="${escapeHtml(invite.link)}" style="display:inline-block;padding:10px 20px;background:#1f2937;color:#fff;border-radius:999px;text-decoration:none;">Accept the invitation</a></p>
     <p>Sign in (or create an account) with this email address, then accept. You will set up an authenticator app before you can use the console.</p>
     <p style="color:#7f8c8d;font-size:12px;">This link expires on ${invite.expiresAt.toUTCString()}. If you did not expect it, ignore this email.</p>`
  );

const contactLine = (contactUrl: string) =>
  `<p>If you think this is a mistake, <a href="${escapeHtml(contactUrl)}">contact us</a> and quote this email.</p>`;

export const getAccountSuspendedTemplate = (notice: {
  name: string;
  reason: string;
  until?: Date | null;
  contactUrl: string;
}) =>
  moneyLayout(
    `Your ${SITE_NAME} account is suspended`,
    `<p>Hi ${escapeHtml(notice.name)},</p>
     <p>We have suspended your ${SITE_NAME} account${notice.until ? ` until <strong>${notice.until.toUTCString()}</strong>` : ""}. While it is suspended you cannot sign in or book.</p>
     <p><strong>Reason:</strong> ${escapeHtml(notice.reason)}</p>
     ${notice.until ? "<p>Your account reactivates on its own when the suspension ends.</p>" : ""}
     ${contactLine(notice.contactUrl)}`
  );

export const getAccountBlockedTemplate = (notice: {
  name: string;
  reason: string;
  contactUrl: string;
}) =>
  moneyLayout(
    `Your ${SITE_NAME} account is blocked`,
    `<p>Hi ${escapeHtml(notice.name)},</p>
     <p>We have blocked your ${SITE_NAME} account. You can no longer sign in or book.</p>
     <p><strong>Reason:</strong> ${escapeHtml(notice.reason)}</p>
     ${contactLine(notice.contactUrl)}`
  );

export const getAccountReactivatedTemplate = (notice: { name: string; signInUrl: string }) =>
  moneyLayout(
    `Your ${SITE_NAME} account is active again`,
    `<p>Hi ${escapeHtml(notice.name)},</p>
     <p>Your ${SITE_NAME} account is active again. You can <a href="${escapeHtml(notice.signInUrl)}">sign in</a> and book as usual.</p>`
  );

/** To a customer or owner when support starts a read-only "View as" of their account. */
export const getImpersonationNoticeTemplate = (notice: { name: string; minutes: number; contactUrl: string }) =>
  moneyLayout(
    `${SITE_NAME} support viewed your account`,
    `<p>Hi ${escapeHtml(notice.name)},</p>
     <p>A member of the ${SITE_NAME} support team opened a read-only view of your account to help with a request. The view lasts at most ${notice.minutes} minutes and cannot change, book, cancel or pay for anything.</p>
     <p>If you did not ask us for help, <a href="${escapeHtml(notice.contactUrl)}">contact us</a>.</p>`
  );

/** Sent to the affected admin and every SUPER_ADMIN on a team change. */
export const getAdminTeamChangeTemplate = (notice: {
  heading: string;
  summary: string;
  actorName: string;
  reason?: string | null;
}) =>
  moneyLayout(
    notice.heading,
    `<p>${escapeHtml(notice.summary)}</p>
     <p><strong>Changed by:</strong> ${escapeHtml(notice.actorName)}</p>
     ${notice.reason ? `<p><strong>Reason:</strong> ${escapeHtml(notice.reason)}</p>` : ""}
     <p style="color:#7f8c8d;font-size:12px;">If you did not expect this change, contact another super admin at once.</p>`
  );

const buttonLink = (href: string, label: string) =>
  `<p><a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 20px;background:#1f2937;color:#fff;border-radius:999px;text-decoration:none;">${escapeHtml(label)}</a></p>`;

/** To a salon owner when an admin approves, rejects, suspends or reactivates a salon. */
export const getSalonStatusTemplate = (notice: {
  kind: "approved" | "rejected" | "suspended" | "reactivated";
  ownerName: string;
  salonName: string;
  reason?: string | null;
  fixHint?: string | null;
  link: string;
  contactUrl: string;
}) => {
  const name = escapeHtml(notice.ownerName);
  const salon = `<strong>${escapeHtml(notice.salonName)}</strong>`;
  const reason = notice.reason ? `<p><strong>Reason:</strong> ${escapeHtml(notice.reason)}</p>` : "";
  switch (notice.kind) {
    case "approved":
      return moneyLayout(
        `Your salon is live on ${SITE_NAME}`,
        `<p>Hi ${name},</p>
         <p>Good news: ${salon} is approved and customers can now find and book it.</p>
         ${buttonLink(notice.link, "See your salon")}`
      );
    case "rejected":
      return moneyLayout(
        "Your salon was not approved",
        `<p>Hi ${name},</p>
         <p>We could not approve ${salon} yet.</p>
         ${reason}
         ${notice.fixHint ? `<p><strong>What to fix:</strong> ${escapeHtml(notice.fixHint)}</p>` : ""}
         <p>Update the details and save; the salon goes back into our review queue.</p>
         ${buttonLink(notice.link, "Fix and resubmit")}
         ${contactLine(notice.contactUrl)}`
      );
    case "suspended":
      return moneyLayout(
        "Your salon is suspended",
        `<p>Hi ${name},</p>
         <p>We have suspended ${salon}. While it is suspended customers cannot find or book it.</p>
         ${reason}
         ${contactLine(notice.contactUrl)}`
      );
    default:
      return moneyLayout(
        "Your salon is live again",
        `<p>Hi ${name},</p>
         <p>${salon} is active again and customers can find and book it.</p>
         ${buttonLink(notice.link, "See your salon")}`
      );
  }
};

/** To an applicant when their salon-owner application is decided. */
export const getOwnerApplicationDecisionTemplate = (notice: {
  approved: boolean;
  name: string;
  businessName: string;
  reason?: string | null;
  link: string;
  contactUrl: string;
}) =>
  notice.approved
    ? moneyLayout(
        `You are now a salon owner on ${SITE_NAME}`,
        `<p>Hi ${escapeHtml(notice.name)},</p>
         <p>Your application for <strong>${escapeHtml(notice.businessName)}</strong> is approved. Sign out and back in, then add your salon from the dashboard; we review each salon before it goes live.</p>
         ${buttonLink(notice.link, "Add your salon")}`
      )
    : moneyLayout(
        "Your salon owner application was not approved",
        `<p>Hi ${escapeHtml(notice.name)},</p>
         <p>We could not approve your application for <strong>${escapeHtml(notice.businessName)}</strong>.</p>
         ${notice.reason ? `<p><strong>Reason:</strong> ${escapeHtml(notice.reason)}</p>` : ""}
         <p>You can correct the details and apply again.</p>
         ${buttonLink(notice.link, "Apply again")}
         ${contactLine(notice.contactUrl)}`
      );

/** An admin cancelled a booking on the customer's behalf. Sent to the customer and the salon. */
export const getBookingCancelledByAdminTemplate = (notice: {
  audience: "customer" | "salon";
  name: string;
  salonName: string;
  serviceName: string;
  when: string;
  token: string | null;
  reason: string;
  refund: string | null;
  contactUrl: string;
}) =>
  moneyLayout(
    "Booking cancelled",
    `<p>Hi ${escapeHtml(notice.name)},</p>
     <p>${SITE_NAME} cancelled ${notice.audience === "customer" ? "your" : "a"} booking${
       notice.token ? ` <strong>${escapeHtml(notice.token)}</strong>` : ""
     } for ${escapeHtml(notice.serviceName)} at ${escapeHtml(notice.salonName)} on ${escapeHtml(notice.when)}${
       notice.audience === "customer" ? "" : " on the customer's behalf"
     }.</p>
     <p><strong>Reason:</strong> ${escapeHtml(notice.reason)}</p>
     ${
       notice.audience === "customer"
         ? notice.refund
           ? `<p>Your full deposit of <strong>${notice.refund}</strong> is back in your wallet.</p>`
           : ""
         : "<p>The slot is open again. Nothing is deducted from your earnings.</p>"
     }
     ${contactLine(notice.contactUrl)}`
  );

/**
 * A moderator hid the customer's review. Says why by reason code only - never
 * who reported it.
 */
export const getReviewHiddenTemplate = (notice: {
  name: string;
  salonName: string;
  reason: string;
  contactUrl: string;
}) =>
  moneyLayout(
    "Your review has been hidden",
    `<p>Hi ${escapeHtml(notice.name)},</p>
     <p>We have hidden your review of ${escapeHtml(notice.salonName)} because it did not meet our review guidelines. It no longer appears on the salon's page or counts toward its rating.</p>
     <p><strong>Reason:</strong> ${escapeHtml(notice.reason)}</p>
     ${contactLine(notice.contactUrl)}`
  );

/** The salon answered a customer's review in public. */
export const getReviewReplyTemplate = (notice: {
  name: string;
  salonName: string;
  reply: string;
  salonUrl: string;
}) =>
  moneyLayout(
    "The salon replied to your review",
    `<p>Hi ${escapeHtml(notice.name)},</p>
     <p>${escapeHtml(notice.salonName)} replied to your review:</p>
     <blockquote style="margin:12px 0;padding:8px 12px;border-left:3px solid #c8a24a;color:#34495e;">${escapeHtml(notice.reply).replace(/\r?\n/g, "<br>")}</blockquote>
     <p><a href="${escapeHtml(notice.salonUrl)}">See it on the salon's page</a></p>`
  );

/** An admin's reply on a support ticket. The subject carries `[#<number>]`. */
export const getSupportReplyTemplate = (reply: {
  name: string;
  number: number;
  subject: string;
  body: string;
}) =>
  moneyLayout(
    `Re: ${reply.subject}`,
    `<p>Hi ${escapeHtml(reply.name)},</p>
     <div style="white-space:normal;">${escapeHtml(reply.body).replace(/\r?\n/g, "<br>")}</div>
     <p style="color:#7f8c8d;font-size:12px;margin-top:24px;">Ticket #${reply.number}. Reply to this email to answer us.</p>`
  );

/** `system.watch`: the alerts that just started or stopped, in one email. */
export const getSystemAlertTemplate = (notice: {
  firing: Array<{ label: string; detail: string }>;
  resolved: Array<{ label: string; detail: string }>;
  url: string;
}) => {
  const list = (items: Array<{ label: string; detail: string }>) =>
    `<ul style="padding-left:18px;">${items
      .map((i) => `<li><strong>${escapeHtml(i.label)}</strong> - ${escapeHtml(i.detail)}</li>`)
      .join("")}</ul>`;
  return moneyLayout(
    notice.firing.length ? "System alert" : "System alert resolved",
    `${notice.firing.length ? `<p>These checks started failing:</p>${list(notice.firing)}` : ""}${
      notice.resolved.length ? `<p>These are healthy again:</p>${list(notice.resolved)}` : ""
    }
     <p><a href="${notice.url}" style="color:#2c3e50;font-weight:bold;">Open System health</a></p>
     <p style="color:#7f8c8d;font-size:13px;">You get these because "Email me alerts" is on for your admin account. One email per alert every 6 hours at most.</p>`,
  );
};

/** `admin.digest`: yesterday at a glance, once a day after 08:00 Dhaka. */
export const getAdminDigestTemplate = (digest: {
  day: string;
  kpis: Array<{ label: string; value: string }>;
  inbox: Array<{ label: string; count: number }>;
  alerts: Array<{ label: string; since: string }>;
  url: string;
}) => {
  const rows = (items: Array<[string, string]>) =>
    `<table style="width:100%;border-collapse:collapse;font-size:14px;">${items
      .map(
        ([k, v]) =>
          `<tr><td style="padding:6px 0;border-bottom:1px solid #eee;">${escapeHtml(k)}</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;"><strong>${escapeHtml(v)}</strong></td></tr>`,
      )
      .join("")}</table>`;
  return moneyLayout(
    `Daily digest - ${escapeHtml(digest.day)}`,
    `<h3 style="margin:0 0 6px;">Yesterday</h3>${rows(digest.kpis.map((k) => [k.label, k.value]))}
     <h3 style="margin:22px 0 6px;">Needs attention</h3>${
       digest.inbox.length ? rows(digest.inbox.map((i) => [i.label, String(i.count)])) : "<p>Nothing waiting.</p>"
     }
     <h3 style="margin:22px 0 6px;">Alerts firing</h3>${
       digest.alerts.length ? rows(digest.alerts.map((a) => [a.label, `since ${a.since}`])) : "<p>None. All checks are healthy.</p>"
     }
     <p style="margin-top:22px;"><a href="${digest.url}" style="color:#2c3e50;font-weight:bold;">Open the back office</a></p>`,
  );
};

/** dues.watch and dues payments: reminder, pause warning, paused, resumed. */
export const getDuesNoticeTemplate = (notice: {
  ownerName: string;
  kind: "reminder" | "warning" | "paused" | "resumed";
  amount: string;
  pauseDate?: string | null;
  url: string;
}) => {
  const heading = {
    reminder: "You have dues to pay",
    warning: "Online bookings pause in 3 days",
    paused: "Online bookings are paused",
    resumed: "Online bookings resumed",
  }[notice.kind];
  const body = {
    reminder: `<p>Your business owes <strong>${escapeHtml(notice.amount)}</strong> in fees. You can clear it with bKash in two taps.</p>`,
    warning: `<p>Your business owes <strong>${escapeHtml(notice.amount)}</strong>. Unless it is paid${
      notice.pauseDate ? ` by <strong>${escapeHtml(notice.pauseDate)}</strong>` : ""
    }, your salons stop taking new online bookings. Walk-ins and existing bookings are not affected.</p>`,
    paused: `<p>Your business owes <strong>${escapeHtml(notice.amount)}</strong>, so your salons are no longer taking new online bookings. Walk-ins and existing bookings are not affected. Bookings resume as soon as the dues are paid.</p>`,
    resumed: `<p>Thank you - your dues are cleared and your salons are taking online bookings again.</p>`,
  }[notice.kind];
  return moneyLayout(
    heading,
    `<p>Hi ${escapeHtml(notice.ownerName)},</p>
     ${body}
     <p><a href="${escapeHtml(notice.url)}">${notice.kind === "resumed" ? "Open Money" : "Pay dues"}</a></p>`,
  );
};

/** The salon moved a customer's booking to another time. Deposit and price stay. */
export const getBookingRescheduledTemplate = (notice: {
  name: string;
  salonName: string;
  serviceName: string;
  token: string | null;
  from: string;
  to: string;
  contactUrl: string;
}) =>
  moneyLayout(
    `Your booking moved to ${escapeHtml(notice.to)}`,
    `<p>Hi ${escapeHtml(notice.name)},</p>
     <p>${escapeHtml(notice.salonName)} moved your booking${
       notice.token ? ` <strong>${escapeHtml(notice.token)}</strong>` : ""
     } for ${escapeHtml(notice.serviceName)}.</p>
     <p><strong>Was:</strong> ${escapeHtml(notice.from)}<br/><strong>Now:</strong> ${escapeHtml(notice.to)}</p>
     <p>Your deposit and price are unchanged. If the new time does not suit you, contact the salon or cancel from your bookings.</p>
     ${contactLine(notice.contactUrl)}`
  );

const BRANCH_ROLE_LABEL: Record<string, string> = {
  MANAGER: "a branch manager",
  RECEPTIONIST: "a receptionist",
  STYLIST: "a stylist",
};

export const branchRoleLabel = (role: string) => BRANCH_ROLE_LABEL[role] ?? role.toLowerCase();

export const getTeamInvitationTemplate = (invite: {
  name?: string | null;
  inviterName: string;
  salonName: string;
  role: string;
  link: string;
  expiresAt: Date;
}) =>
  moneyLayout(
    `Join ${escapeHtml(invite.salonName)} on ${SITE_NAME}`,
    `<p>Hi ${escapeHtml(invite.name || "there")},</p>
     <p>${escapeHtml(invite.inviterName)} invited you to work at <strong>${escapeHtml(invite.salonName)}</strong> as <strong>${escapeHtml(branchRoleLabel(invite.role))}</strong>.</p>
     <p><a href="${escapeHtml(invite.link)}" style="display:inline-block;padding:10px 20px;background:#1f2937;color:#fff;border-radius:999px;text-decoration:none;">Accept the invitation</a></p>
     <p>Sign in (or create an account) with this email address, then accept. You will only see this branch's work.</p>
     <p style="color:#7f8c8d;font-size:12px;">This link expires on ${invite.expiresAt.toUTCString()}. If you did not expect it, ignore this email.</p>`,
  );

export const getTeamJoinedTemplate = (notice: {
  ownerName: string;
  memberName: string;
  memberEmail: string;
  salonName: string;
  role: string;
}) =>
  moneyLayout(
    `${escapeHtml(notice.memberName)} joined ${escapeHtml(notice.salonName)}`,
    `<p>Hi ${escapeHtml(notice.ownerName)},</p>
     <p><strong>${escapeHtml(notice.memberName)}</strong> (${escapeHtml(notice.memberEmail)}) accepted the invitation and now works at <strong>${escapeHtml(notice.salonName)}</strong> as ${escapeHtml(branchRoleLabel(notice.role))}.</p>
     <p>You can change their role or remove them from the Team page at any time.</p>`,
  );

/** To a salon owner when an admin decides a branch's Home Service or one of its experts. */
export const getHomeServiceDecisionTemplate = (notice: {
  kind: "branch_approved" | "branch_rejected" | "branch_suspended" | "expert_verified" | "expert_rejected";
  ownerName: string;
  salonName: string;
  expertName?: string | null;
  reason?: string | null;
  link: string;
  contactUrl: string;
}) => {
  const name = escapeHtml(notice.ownerName);
  const salon = `<strong>${escapeHtml(notice.salonName)}</strong>`;
  const expert = `<strong>${escapeHtml(notice.expertName ?? "Your expert")}</strong>`;
  const reason = notice.reason ? `<p><strong>Reason:</strong> ${escapeHtml(notice.reason)}</p>` : "";
  switch (notice.kind) {
    case "branch_approved":
      return moneyLayout(
        "Home Service is live",
        `<p>Hi ${name},</p>
         <p>Home Service at ${salon} is approved. Customers can now book your verified experts for home visits.</p>
         ${buttonLink(notice.link, "Open Home Service")}`
      );
    case "branch_rejected":
      return moneyLayout(
        "Home Service was not approved",
        `<p>Hi ${name},</p>
         <p>We could not approve Home Service at ${salon} yet.</p>
         ${reason}
         <p>Fix what is listed above and turn Home Service on again; it comes back to our review queue.</p>
         ${buttonLink(notice.link, "Fix and turn on")}
         ${contactLine(notice.contactUrl)}`
      );
    case "branch_suspended":
      return moneyLayout(
        "Home Service is suspended",
        `<p>Hi ${name},</p>
         <p>We have suspended Home Service at ${salon}. While it is suspended customers cannot book home visits from this branch.</p>
         ${reason}
         ${contactLine(notice.contactUrl)}`
      );
    case "expert_verified":
      return moneyLayout(
        "Home expert verified",
        `<p>Hi ${name},</p>
         <p>${expert} at ${salon} is verified and can now take home visits for the services linked to them.</p>
         ${buttonLink(notice.link, "Open Home Service")}`
      );
    default:
      return moneyLayout(
        "Home expert not verified",
        `<p>Hi ${name},</p>
         <p>We could not verify ${expert} at ${salon}.</p>
         ${reason}
         <p>Update their documents and submit them again.</p>
         ${buttonLink(notice.link, "Update documents")}
         ${contactLine(notice.contactUrl)}`
      );
  }
};
