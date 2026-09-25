/**
 * Where the database and the environment stand before the auth update (email
 * one-time codes and Sign in with Google) - against the real database.
 *
 *   npm run auth:check
 *
 * Read-only: SELECTs through $queryRaw, nothing else. It prints counts, roles
 * and flags only - never an email, an id or a secret value - so the output is
 * safe to paste into a ticket. Always exits 0: it is a report, not a gate.
 */
import config from "../config";
import prisma from "../app/shared/prisma";
import { resendProvider } from "../app/utils/email/resend.provider";
import { smtpProvider } from "../app/utils/email/smtp.provider";

/** Same cleaning as config's env(): a value pasted on a host may carry quotes. */
const envValue = (name: string): string => {
  const trimmed = (process.env[name] ?? "").trim();
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  return quoted ? trimmed.slice(1, -1).trim() : trimmed;
};

const yesNo = (value: boolean) => (value ? "yes" : "no");

const heading = (title: string) => console.log(`\n== ${title}`);

/**
 * The provider emailSender would pick, without calling it: its resolver logs
 * the sender address and a key fingerprint, which do not belong in this output.
 */
const emailProviderName = () => {
  const requested = config.email.provider?.trim().toLowerCase();
  const providers = [resendProvider, smtpProvider];

  if (requested && requested !== "auto") {
    const pinned = providers.find((provider) => provider.name === requested);
    if (!pinned) return `${requested} (unknown provider - nothing will be sent)`;
    return pinned.isConfigured()
      ? `${pinned.name} (pinned by EMAIL_PROVIDER)`
      : `${pinned.name} (pinned but not configured - nothing will be sent)`;
  }

  const first = providers.find((provider) => provider.isConfigured());
  return first ? `${first.name} (first configured)` : "none";
};

/** Prisma's connection errors name the host; keep that out of pasted output. */
const redact = (message: string) =>
  message
    .replace(/postgres(ql)?:\/\/\S+/gi, "<database url>")
    .replace(/`[^`\s]+:\d+`/g, "`<host>`");

type RoleRow = { role: string; emailVerified: boolean; users: bigint; withPhone: bigint };
type DuplicateRow = { rows: bigint; roles: string[]; deleted: boolean[] };
type CountRow = { count: bigint };

const main = async () => {
  heading("1. Users (not deleted) by role and emailVerified");
  const byRole = await prisma.$queryRaw<RoleRow[]>`
    SELECT role::text AS role, "emailVerified",
           count(*) AS users, count(phone) AS "withPhone"
    FROM users
    WHERE "isDeleted" = false
    GROUP BY role, "emailVerified"
    ORDER BY role, "emailVerified"`;
  console.table(
    byRole.map((row) => ({
      role: row.role,
      emailVerified: row.emailVerified,
      users: Number(row.users),
      withPhone: Number(row.withPhone),
    })),
  );

  // Grouped on trim + lower, the normalisation the auth update applies, so a
  // pair that differs only by stray whitespace is caught too.
  heading("2. Emails that collide once trimmed and lower-cased (all rows, deleted included)");
  const duplicates = await prisma.$queryRaw<DuplicateRow[]>`
    SELECT count(*) AS rows,
           array_agg(role::text ORDER BY "createdAt") AS roles,
           array_agg("isDeleted" ORDER BY "createdAt") AS deleted
    FROM users
    GROUP BY lower(trim(email))
    HAVING count(*) > 1`;
  console.log(`duplicate groups: ${duplicates.length}`);
  duplicates.forEach((group, index) => {
    const members = group.roles
      .map((role, i) => `${role}${group.deleted[i] ? " (deleted)" : ""}`)
      .join(", ");
    console.log(`  group ${index + 1}: ${Number(group.rows)} rows - ${members}`);
  });

  heading("3. Emails not already trimmed and lower-case");
  const [notNormalised] = await prisma.$queryRaw<CountRow[]>`
    SELECT count(*) AS count FROM users WHERE email <> lower(trim(email))`;
  console.log(`rows: ${Number(notNormalised.count)}`);

  heading("4. Users without a password (should be 0 before Phase 1)");
  const [noPassword] = await prisma.$queryRaw<CountRow[]>`
    SELECT count(*) AS count FROM users WHERE password IS NULL`;
  console.log(`rows: ${Number(noPassword.count)}`);

  heading("5. Phase 1 schema");
  const [schema] = await prisma.$queryRaw<
    { otpChallenges: string | null; authIdentities: string | null; sessionVersion: bigint }[]
  >`
    SELECT to_regclass('public.otp_challenges')::text AS "otpChallenges",
           to_regclass('public.auth_identities')::text AS "authIdentities",
           (SELECT count(*) FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'users'
               AND column_name = 'sessionVersion') AS "sessionVersion"`;
  console.log(`otp_challenges table:       ${yesNo(schema.otpChallenges !== null)}`);
  console.log(`auth_identities table:      ${yesNo(schema.authIdentities !== null)}`);
  console.log(`users."sessionVersion":     ${yesNo(Number(schema.sessionVersion) > 0)}`);

  heading("6. Config (values never printed)");
  const otpSecret = envValue("AUTH_OTP_SECRET");
  const flag = (name: string) => envValue(name) || "(unset)";
  const googleKeys = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"];
  console.log(`AUTH_OTP_SECRET set:            ${yesNo(otpSecret.length > 0)}`);
  console.log(`AUTH_OTP_SECRET length >= 32:   ${yesNo(otpSecret.length >= 32)}`);
  console.log(
    `AUTH_OTP_SECRET equals JWT_SECRET: ${
      otpSecret ? yesNo(otpSecret === config.jwt.jwt_secret) : "n/a (unset)"
    }  <- must be "no"`,
  );
  googleKeys.forEach((key) =>
    console.log(`${`${key} set:`.padEnd(32)}${yesNo(envValue(key).length > 0)}`),
  );
  console.log(
    `isGoogleEnabled:                ${yesNo(googleKeys.every((key) => envValue(key).length > 0))}`,
  );
  console.log(`REQUIRE_EMAIL_VERIFICATION:     ${flag("REQUIRE_EMAIL_VERIFICATION")}`);
  console.log(`GOOGLE_SIGNUP_REQUIRES_OTP:     ${flag("GOOGLE_SIGNUP_REQUIRES_OTP")}`);
  console.log(`AUTH_DEV_LOG_OTP:               ${flag("AUTH_DEV_LOG_OTP")}`);
  console.log(`INTERNAL_API_KEY set:           ${yesNo(config.internalApiKey.length > 0)}`);
  console.log(`email provider:                 ${emailProviderName()}`);

  await prisma.$disconnect();
  process.exit(0);
};

main().catch(async (error) => {
  console.error("\nauth:check could not finish:");
  console.error(redact(String(error?.message ?? error)));
  await prisma.$disconnect();
  // Exit 0 by design: this is a report, never a build gate.
  process.exit(0);
});
