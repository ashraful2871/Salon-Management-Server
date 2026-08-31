export const getBookingConfirmationTemplate = (
  customerName: string,
  salonName: string,
  serviceName: string,
  date: string,
  time: string,
  price: number
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
              <td class="detail-value" style="padding: 5px 0;">$${price}</td>
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
