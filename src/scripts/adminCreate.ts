/**
 * Creates an admin account without ever choosing, storing or printing a
 * password: the account starts with none and the new admin sets one through
 * the ordinary reset-password link, which is emailed to them.
 *
 *   npm run admin:create -- --email you@example.com --name "Your Name"
 *
 * This replaces the old default admin (admin@salon.com / admin123456) in
 * production. If the email cannot be sent the link is printed instead — this
 * is break-glass access for whoever holds a shell on the server.
 */
import { TokenType } from "@prisma/client";
import config from "../config";
import prisma from "../app/shared/prisma";
import { sendEmail } from "../app/utils/emailSender";
import { getPasswordResetTemplate } from "../app/utils/emailTemplates";
import { issueToken } from "../app/utils/verificationToken";
import { normalizeEmail } from "../app/utils/normalizeEmail";

// Longer than the 15-minute forgot-password link: the new admin may not be
// at their inbox. After it lapses, "forgot password" on /login still works.
const SETUP_LINK_TTL_MINUTES = 60;

const USAGE =
  'Usage: npm run admin:create -- --email you@example.com --name "Your Name"';

const argValue = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};

const main = async () => {
  const rawEmail = argValue("--email");
  const name = argValue("--name")?.trim();

  if (!rawEmail || !rawEmail.includes("@") || !name) {
    console.error(USAGE);
    process.exit(1);
  }

  const email = normalizeEmail(rawEmail);

  const existing = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });

  if (existing) {
    console.error(`Refusing: an account with ${email} already exists.`);
    process.exit(1);
  }

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email,
        name,
        role: "ADMIN",
        status: "ACTIVE",
        emailVerified: true,
        emailVerifiedAt: new Date(),
      },
    });

    await tx.admin.create({
      data: {
        userId: created.id,
        canManageUsers: true,
        canManageSalons: true,
        canManageServices: true,
        canViewReports: true,
        adminRole: "SUPER_ADMIN",
      },
    });

    return created;
  });

  const rawToken = await issueToken(
    user.id,
    TokenType.PASSWORD_RESET,
    SETUP_LINK_TTL_MINUTES * 60 * 1000,
  );
  const resetUrl = `${config.frontend_url}/reset-password?token=${rawToken}`;

  const result = await sendEmail(
    user.email,
    "Set your password - Salon Management admin",
    getPasswordResetTemplate(user.name, resetUrl, SETUP_LINK_TTL_MINUTES),
  );

  console.log(`Admin created: ${user.email}`);

  if (result.ok) {
    console.log("Check the inbox for the set-your-password link.");
  } else {
    console.log(`The email could not be sent (${result.error}).`);
    console.log(
      `Set the password within ${SETUP_LINK_TTL_MINUTES} minutes at this link — do not share it:`,
    );
    console.log(resetUrl);
  }
};

main()
  .catch((error) => {
    console.error("admin:create failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
