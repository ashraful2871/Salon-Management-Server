import { sendEmail } from "./src/app/utils/emailSender";
import { getBookingConfirmationTemplate } from "./src/app/utils/emailTemplates";
import * as dotenv from 'dotenv';
dotenv.config();

const testEmail = async () => {
  console.log("Starting email test...");
  
  // Generate the HTML template
  const html = getBookingConfirmationTemplate(
    "John Doe",
    "Luxury Salon",
    "Haircut & Styling",
    "2026-09-01",
    "10:00 AM",
    50
  );

  // Send the email (Replace with an email address you want to pretend is the customer)
  await sendEmail("testcustomer@example.com", "Test Booking Confirmation", html);
  
  console.log("Email test finished. Check your Mailtrap inbox!");
};

testEmail();
