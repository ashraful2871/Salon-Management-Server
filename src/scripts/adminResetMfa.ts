/**
 * Break-glass reset of an admin's or agent's two-factor sign-in, for a lost
 * phone with no recovery codes left. Deletes the UserMfa row (the account
 * enrols again on its next sign-in) and bumps sessionVersion so every open
 * session ends. Writes an audit row with source "cli".
 *
 *   npm run admin:reset-mfa -- --email someone@example.com
 */
import prisma from "../app/shared/prisma";
import { auditTx, systemAuditCtx } from "../app/utils/audit";
import { normalizeEmail } from "../app/utils/normalizeEmail";

const USAGE = "Usage: npm run admin:reset-mfa -- --email someone@example.com";

const argValue = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};

const main = async () => {
  const rawEmail = argValue("--email");
  if (!rawEmail || !rawEmail.includes("@")) {
    console.error(USAGE);
    process.exit(1);
  }
  const email = normalizeEmail(rawEmail);

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" }, isDeleted: false },
    select: { id: true, role: true, mfa: { select: { enabledAt: true } } },
  });
  if (!user) {
    console.error(`No account with the email ${email}.`);
    process.exit(1);
  }
  if (!user.mfa) {
    console.log(`${email} has no two-factor sign-in set up. Nothing to reset.`);
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.userMfa.delete({ where: { userId: user.id } });
    await tx.user.update({
      where: { id: user.id },
      data: { sessionVersion: { increment: 1 } },
    });
    await auditTx(tx, systemAuditCtx("cli"), {
      action: "mfa.reset",
      entityType: "user",
      entityId: user.id,
      before: { role: user.role, enabledAt: user.mfa?.enabledAt ?? null },
      reason: "admin:reset-mfa",
    });
  });

  console.log(`Two-factor sign-in reset for ${email}. They enrol again at their next sign-in.`);
};

main()
  .catch((error) => {
    console.error("admin:reset-mfa failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
