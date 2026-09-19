# Email setup

Everything about how this API sends email: why it changed, what to configure,
how to verify it, and what each failure means.

---

## 1. The problem this solves

Email worked locally and silently failed on Render. The deploy log showed two
errors in sequence, over and over:

```
Error sending email: Error: connect ETIMEDOUT              ... command: 'CONN'
Error sending email: Error: connect ENETUNREACH 2607:f8b0:400e:c1b::6d:587
    errno: -101, code: 'ESOCKET', syscall: 'connect', port: 587
```

Read in order, they are one story:

1. `2607:f8b0::/32` is Google's IPv6 range, so that address is `smtp.gmail.com`.
2. Nodemailer resolves a host to its IPv4 addresses first, then its IPv6 ones,
   and walks down the list on failure.
3. The IPv4 attempt to port 587 **timed out** — not refused, *dropped*, which is
   what a firewall does. Render blocks outbound SMTP.
4. The IPv6 fallback then failed instantly with `ENETUNREACH` (errno -101,
   "network unreachable") because the container has no route to the IPv6
   internet at all.

It was never the credentials: a bad Gmail app password returns
`535 Username and Password not accepted`, and a missing host returns
`ECONNREFUSED 127.0.0.1:587`. Neither appeared, because the connection never got
far enough to send a single byte of SMTP.

**The fix is the port, not the password.** HTTPS on 443 is never blocked, so the
API now sends through an HTTP email API and keeps SMTP only for local use.

---

## 2. What changed in the code

| File | What it is |
|---|---|
| `src/app/utils/emailSender.ts` | The only entry point. `sendEmail(to, subject, html)` — **unchanged signature**, so all six templates and all five call sites work as before. |
| `src/app/utils/email/types.ts` | The `EmailProvider` interface. |
| `src/app/utils/email/resend.provider.ts` | Resend over its HTTPS API. Plain `fetch`, no SDK dependency. Retries 429 and 5xx three times with backoff. |
| `src/app/utils/email/smtp.provider.ts` | Nodemailer, kept for local development. Now pinned to IPv4, with 10s connect timeouts instead of nodemailer's 2-minute default, and one pooled transporter instead of a new one per email. |
| `src/config/index.ts` | New `email` block; `SMTP_*` now reads through config like everything else. |
| `src/scripts/testEmail.ts` | `npm run test:email -- you@example.com` |

Two behaviours worth knowing:

- **`sendEmail` still never throws.** A receipt that cannot be delivered must not
  roll back the payment that earned it. It now returns
  `{ ok, provider, error }` and logs failures loudly with an `[email]` prefix —
  the old version swallowed them silently, which is exactly why a production
  outage looked like "the mail just never arrives".
- **Provider selection is automatic.** `EMAIL_PROVIDER` pins one explicitly;
  left empty, the first provider that has credentials wins, and Resend is
  checked first. So setting `RESEND_API_KEY` in production is enough — you do
  not have to remove the SMTP variables.

On boot the log line tells you which one is live:

```
[email] sending through resend as Salon Management <no-reply@yourdomain.com>
```

---

## 3. Setting it up

### Step 1 — Create a Resend account

1. Sign up at <https://resend.com> (the free tier covers 3,000 emails a month,
   100 a day — well beyond this project's volume).
2. **API Keys → Create API Key**, permission "Sending access". Copy it now; it
   is shown once. It looks like `re_xxxxxxxxxxxxxxxx`.

### Step 2 — Verify a sending domain

This is the step people skip, and skipping it is why mail lands in spam.

1. **Domains → Add Domain**, enter the domain you send from
   (e.g. `ashrafulash.com`).
2. Resend gives you DNS records — an MX and TXT pair for the return path, a
   `DKIM` TXT record, and optionally DMARC. Add them at your DNS provider.
3. Wait for the dashboard to show **Verified** (usually minutes, up to an hour).
   DMARC is listed as optional and is worth adding anyway — `v=DMARC1; p=none;`
   on `_dmarc` is enough to start, and it measurably helps inbox placement.
4. Your `EMAIL_FROM` must then use that domain:
   `Salon Management <no-reply@ashrafulash.com>`.

**Testing without a domain:** use `EMAIL_FROM="Salon Management <onboarding@resend.dev>"`.
It works immediately but **only delivers to the email address that owns the
Resend account**. Fine for `npm run test:email`, useless for real customers.

### Step 3 — Set the environment variables

This project's verified domain is **`salon.ashrafulash.com`** (Resend, region
Tokyo), so every sending address must be on that domain.

Locally, in `.env`:

```bash
EMAIL_PROVIDER=resend
EMAIL_FROM=Salon Management <no-reply@salon.ashrafulash.com>
RESEND_API_KEY=re_xxxxxxxxxxxxxxxx

# Still used for local development if you prefer SMTP:
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-address@gmail.com
SMTP_PASS=your-16-char-app-password
```

On Render — **Dashboard → your service → Environment → Add Environment Variable**:

| Key | Value |
|---|---|
| `RESEND_API_KEY` | `re_xxxxxxxxxxxxxxxx` |
| `EMAIL_FROM` | `Salon Management <no-reply@salon.ashrafulash.com>` |
| `EMAIL_PROVIDER` | `resend` — pin it in production so a stray `SMTP_HOST` can never win |

Save — Render redeploys automatically. The `SMTP_*` variables can stay; they are
ignored once `EMAIL_PROVIDER=resend`.

**Check `FRONTEND_URL` while you are in there.** Verification and password-reset
emails build their links from it (`${config.frontend_url}/verify-email?token=...`),
so on Render it must be `https://salon.ashrafulash.com` — not the `localhost:3000`
that belongs in the local `.env`. A correct email with a localhost link is still
a broken email.

### Step 4 — Verify

Locally:

```bash
npm run test:email -- you@example.com
```

Expected:

```
provider : resend
from     : Salon Management <no-reply@yourdomain.com>
to       : you@example.com

[email] sent "Salon Management - email delivery test" to you@example.com via resend (a1b2c3...)

OK - accepted by resend in 412ms
```

On Render, run the same command from **Shell** (a paid feature), or just trigger
a real email — register a user, or top up a wallet — and watch **Logs** for the
`[email]` lines. A successful send logs `[email] sent ...`; a failure logs
`[email] FAILED ...` with the reason.

---

## 4. Which emails this covers

All of them go through `sendEmail`, so all of them are fixed by this change:

| Trigger | Template |
|---|---|
| Register | `getEmailVerificationTemplate` |
| Forgot password | `getPasswordResetTemplate` |
| Booking confirmed | `getBookingConfirmationTemplate` |
| Wallet top-up succeeded | `getWalletTopupInvoiceTemplate` (the payment receipt) |
| Deposit returned | `getDepositReleasedTemplate` |
| Deposit forfeited | `getDepositForfeitedTemplate` |

---

## 5. Troubleshooting

| What you see | What it means | Fix |
|---|---|---|
| `[email] no email provider is configured` | Neither `RESEND_API_KEY` nor `SMTP_HOST`+`SMTP_USER` is set. | Set `RESEND_API_KEY` on the host. Check for a typo in the variable name. |
| `FAILED ... via resend: API key is invalid` | Resend does not recognise the string at all — revoked, regenerated, truncated on paste, or from a different Resend account. | See [5.1](#51-api-key-is-invalid-in-production-but-fine-locally). |
| `FAILED ... via resend: The <domain> domain is not verified` | `EMAIL_FROM` uses a domain Resend does not own yet. | Finish Step 2, or use `onboarding@resend.dev` temporarily. |
| `FAILED ... via resend: You can only send testing emails to your own email address` | You are on `onboarding@resend.dev` and sent to someone else. | Verify your own domain. |
| `FAILED ... via resend: HTTP 429` | Rate limit (2 requests/second on free). Already retried three times with backoff. | Usually transient. If constant, upgrade the Resend plan. |
| `FAILED ... via smtp: ETIMEDOUT ... (port 587 appears to be blocked from this host)` | You are on SMTP in production. | Set `RESEND_API_KEY` / `EMAIL_PROVIDER=resend`. |
| `ENETUNREACH ... 2607:f8b0:...` | The old IPv6 fallback. Should not reappear — SMTP is now pinned to IPv4. | Confirm the deploy actually picked up the new code. |
| Send reports OK but nothing arrives | Accepted by the provider, lost after. | Check the spam folder, then Resend's **Emails** log — it shows delivered / bounced / complained per message. |

### 5.1 `API key is invalid` in production but fine locally

The same code sending the same email works from a laptop and is refused on
Render. That difference is the key itself, never the code — the request reached
Resend over HTTPS and Resend answered `401`.

The boot log now prints a fingerprint of the key it loaded:

```
[email] sending through resend as Salon Management <no-reply@salon.ashrafulash.com> with key re_ab12c...7f3d (36 chars)
```

Compare it with the key in **Resend → API Keys**, which is masked the same way.

| Fingerprint says | What happened | Fix |
|---|---|---|
| `not set` | The variable never reached the process. | Check the spelling on Render — it is `RESEND_API_KEY`, and env changes only apply to a **new deploy**. |
| A prefix that is not the one in Resend | The deployed key is a different, older key. | Paste the current one, or create a new key and use that. |
| Noticeably shorter than the local key | The paste was truncated. | Re-copy the whole value. Resend shows a key once, so if it is gone, create a new one. |
| Matches, still rejected | The key was revoked, or belongs to a different Resend account than the verified domain. | Create a fresh key **in the account that owns `salon.ashrafulash.com`**. |

Two things the code now handles so they stop being candidates: a value pasted
with surrounding quotes or a trailing newline is trimmed by `src/config/index.ts`
(with a `[config]` warning, because other tools reading that variable will not
clean it), and a value that does not start with `re_` is called out at boot
rather than on the first send.

Worth knowing while you are in the Render dashboard: **editing an environment
variable triggers a redeploy, and the running instance keeps the old value until
that deploy finishes.** A key fixed two minutes ago and a failure logged one
minute ago are not a contradiction.

### Checking whether a port is blocked

Run this on the host in question (Render Shell, or any box):

```bash
node -e "require('net').createConnection({host:'smtp.gmail.com',port:587,family:4,timeout:8000}).on('connect',()=>console.log('OPEN')).on('timeout',()=>console.log('BLOCKED - timed out')).on('error',e=>console.log('ERR',e.code))"
```

`BLOCKED - timed out` on 587 while port 443 prints `OPEN` is the whole diagnosis
in two commands.

---

## 6. Switching providers later

Adding Brevo, SendGrid or Mailgun is one file. Implement `EmailProvider` from
`src/app/utils/email/types.ts` — `name`, `isConfigured()`, `send()` — add it to
the `PROVIDERS` array in `emailSender.ts`, and select it with `EMAIL_PROVIDER`.
Nothing above the seam changes; the templates and call sites never learn which
transport carried them.

---

## 7. One thing to fix separately

`.env.example` is committed to git and currently contains **real** credentials: a
Gmail app password, a Neon database URL with its password, and the SSLCommerz
store password. Anyone with repository access has them. Rotate all three, and
replace the values in that file with placeholders — it is meant to document
which variables exist, not what they are set to.
