-- Case-insensitive uniqueness for sign-in emails: a DB-level guard behind the
-- app's trim + lower-case normalisation. Prisma cannot express an index on an
-- expression, so it lives here.
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_key" ON "users" (lower("email"));
