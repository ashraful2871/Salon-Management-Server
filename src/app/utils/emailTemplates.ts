export const getBookingConfirmationTemplate = (
  customerName: string,
  salonName: string,
  serviceName: string,
  date: string,
  time: string,
  price: string
) => {
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
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>Appointment Confirmed</h1>
      </div>
      <div class="content">
        <div class="greeting">Hi ${customerName},</div>
        <p>Your appointment at <strong>${salonName}</strong> has been successfully booked. Here are your booking details:</p>
        
        <div class="booking-details">
          <table style="width: 100%; border-collapse: collapse;">
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
