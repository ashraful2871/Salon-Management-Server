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
        <p>&copy; ${new Date().getFullYear()} Salon Management. All rights reserved.</p>
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
      <p>We received a request to reset the password for your Salon Management account.
      Click the button below to choose a new one.</p>
      <p><strong>This link expires in ${expiresInMinutes} minutes and can only be used once.</strong></p>
    `,
    "Reset Password",
    resetUrl,
    "If you did not request a password reset, you can safely ignore this email — your password will not change."
  );

export const getEmailVerificationTemplate = (
  userName: string,
  verifyUrl: string,
  expiresInHours: number
) =>
  baseLayout(
    "Verify Your Email",
    `
      <p style="font-size:18px;">Hi ${userName},</p>
      <p>Welcome to Salon Management! Please confirm your email address so we can
      keep your account secure and send you booking updates.</p>
      <p><strong>This link expires in ${expiresInHours} hours and can only be used once.</strong></p>
    `,
    "Verify Email",
    verifyUrl,
    "If you did not create a Salon Management account, you can safely ignore this email."
  );

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
        Salon Management
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

// For text a customer typed, such as their name. It lands in the salon owner's
// inbox, so it must not be able to add links or markup of its own.
const escapeHtml = (value: string) =>
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
