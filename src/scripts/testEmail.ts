/**
 * Sends one real email through whichever provider the environment selects, and
 * says exactly what happened.
 *
 *   npm run test:email -- you@example.com
 *
 * This exists because "the email never arrived" has too many possible causes to
 * guess at from a booking flow: a blocked port, an unverified sender domain, a
 * wrong key and a typo in an address all look identical from the outside. Run
 * this first - locally, and again on the deployed host - and the answer is in
 * the output.
 */
import { sendEmail, getEmailProviderName } from "../app/utils/emailSender";
import config from "../config";

const main = async () => {
  const to = process.argv[2];

  if (!to || !to.includes("@")) {
    console.error("Usage: npm run test:email -- you@example.com");
    process.exit(1);
  }

  console.log(`provider : ${getEmailProviderName()}`);
  console.log(`from     : ${config.email.from}`);
  console.log(`to       : ${to}`);
  console.log("");

  const started = Date.now();
  const result = await sendEmail(
    to,
    "Salon Management - email delivery test",
    `<div style="font-family:sans-serif;line-height:1.6">
       <h2 style="margin:0 0 12px">Email delivery is working</h2>
       <p>This was sent by <code>npm run test:email</code>.</p>
       <p style="color:#7f8c8d;font-size:13px">
         Provider: ${getEmailProviderName()}<br>
         Sent at: ${new Date().toISOString()}
       </p>
     </div>`,
  );
  const elapsed = Date.now() - started;

  console.log("");

  if (result.ok) {
    console.log(`OK - accepted by ${result.provider} in ${elapsed}ms`);
    console.log("If it does not arrive, check the spam folder and the");
    console.log("provider's own delivery log before touching the code.");
    process.exit(0);
  }

  console.error(`FAILED after ${elapsed}ms via ${result.provider}`);
  console.error(`  ${result.error}`);
  console.error("");

  if (result.provider === "smtp") {
    console.error("SMTP fails on hosts that block outbound port 587. Set");
    console.error("RESEND_API_KEY and EMAIL_FROM to send over HTTPS instead.");
  }

  if (result.provider === "none") {
    console.error("Set RESEND_API_KEY (recommended) or the SMTP_* variables.");
  }

  process.exit(1);
};

void main();
