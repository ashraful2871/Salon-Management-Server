# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install                  # or npm install (both bun.lock and package-lock.json are committed)
npm run dev                  # ts-node-dev on src/server.ts, port from PORT (default env-driven)
npm run build                # tsc -> dist/
npm start                    # node dist/server.js

npx prisma generate          # REQUIRED after any prisma/schema/*.prisma change
npx prisma db push           # dev: sync schema without a migration
npx prisma migrate dev --name <name>
npx prisma migrate deploy    # production / CI

npm run backfill:embeddings          # embed salons whose vector is missing or stale
npm run backfill:embeddings -- --all # re-embed every ACTIVE salon
npm run ai:eval                      # offline query-understanding checks (no DB, no Gemini)
npm run ai:diagnose -- "query" ...   # index coverage + live searches (spends Gemini quota)
```

There is **no test runner, linter, or formatter** configured — no `npm test`, no ESLint/Prettier config. Verification is `npm run build` (strict tsc) plus hitting endpoints manually. Deployment runs `render-build.sh` (install → `prisma generate` → `tsc` → `prisma migrate deploy`); a `.vercel/` project also exists.

`QUICK_START.md` references `npm run prisma:generate` / `prisma:push` scripts that do not exist in `package.json` — use the `npx prisma ...` forms above.

## Request pipeline

Every module follows the same five-file shape under `src/app/modules/<Module>/`: `*.routes.ts` (or `*.route.ts` — both spellings exist), `*.controller.ts`, `*.service.ts`, `*.validation.ts`. New modules must be registered in `src/app/routes/index.ts`, which mounts everything under `/api/v1`.

```
route  →  auth("ROLE",…) | optionalAuth()  →  validateRequest(zodSchema)  →  controller  →  service
```

- **Controllers** are wrapped in `catchAsync` and reply only through `sendResponse(res, { statusCode, success, message, meta?, data? })`. That envelope is the API contract — don't `res.json` directly.
- **Services** import the `prisma` singleton from `src/app/shared/prisma.ts` and throw `ApiError(StatusCodes.X, message)`. There is no repository layer; business rules, ownership checks, and Prisma queries all live in the service.
- **Validation** schemas wrap the whole request: `z.object({ body: z.object({...}) })` — `validateRequest` parses `{ body, query, params }` together.
- `globalErrorHandler` maps ZodError → 400 with `errorDetails[]`, Prisma `P2002`/`P2025`/`P2003` (matched on `err.name`, not `instanceof`) → 409/404/400, then `ApiError`. It is registered *before* `notFound` in `src/app.ts`.
- CORS origins are a hardcoded allowlist in `src/app.ts` — new frontend domains must be added there.

## Auth model

`auth(...roles)` accepts a token from either `Authorization` (with or without `Bearer `) **or** the `accessToken` cookie, then **re-reads the user from the database on every request** and authorizes against `user.role` from the DB, not the role in the token — a role change takes effect immediately without reissuing tokens. `req.user` is `{ userId, email, role }`.

`optionalAuth()` is for public endpoints whose output depends on who is asking: it attaches `req.user` when a valid token is present and silently continues otherwise. `GET /salons` uses it to widen results for ADMIN/AGENT and to scope an AGENT to their own `area`.

Login and register both set `accessToken` and `refreshToken` as httpOnly cookies *and* return them in the body. Access tokens are signed with `JWT_SECRET`, refresh tokens with `REFRESH_TOKEN_SECRET`; the `ACCESS_TOKEN_SECRET` / `ACCESS_TOKEN_EXPIRES_IN` entries in `.env.example` are not read by `src/config/index.ts`.

Password-reset and email-verify tokens (`src/app/utils/verificationToken.ts`): random 32 bytes emailed once, only the sha256 persisted in `verification_tokens`; issuing a token consumes all outstanding tokens of that type for the user, and `consumeToken` marks used via a conditional `updateMany` so concurrent redemptions cannot both win. `sendEmail` never throws by design — a mail failure must never fail the registration or booking it is attached to; it logs loudly and returns `{ ok, provider, error }` instead (see **Email** below).

Roles are `CUSTOMER | STAFF | SALON_OWNER | ADMIN | AGENT`. **AGENT** is an area-scoped moderator (created by ADMIN via `POST /agents/create`, carries division/district/area) who can approve salon status within their area; it predates and is missing from `README.md`/`functionality.md`.

`src/app/seed/admin.seed.ts` runs on every boot and creates `admin@salon.com` / `admin123456` when no ADMIN exists.

## Prisma schema layout

`package.json` sets `"prisma": { "schema": "./prisma/schema" }` and the generator enables `prismaSchemaFolder` — models are split by domain across `prisma/schema/*.prisma` with shared enums in `enum.prisma`. **Migrations live in `prisma/schema/migrations/`**; the top-level `prisma/migrations/` directory is a stale UTF-16 leftover and is not the active migration history.

The `postgresqlExtensions` preview feature enables `pgvector`.

## AI salon search (hybrid: rules + Gemini + pgvector + PostGIS)

`POST /ai/search` lives in `src/app/modules/AI-Suggestion/`, one concern per file: `ai.gemini.ts` is the only code that talks to Gemini (official `@google/genai` SDK), `ai.intent.ts` reads the query, `ai.search.ts` retrieves and ranks, `ai.service.ts` orchestrates and writes the reply, `ai.indexer.ts` keeps vectors current. `AI_REPORT.md` at the workspace root explains why it is built this way.

- **Every ACTIVE salon is a candidate.** Never filter on `embedding IS NOT NULL` — that is how 12 of 13 salons once became unfindable. A missing vector only costs the semantic signal.
- **Query understanding is rules first** (services in English/Bangla/Banglish, prices, ratings, "near me", "open now", and every area/district/city that has a salon, read from the DB). The model is asked only when words are left unexplained; its JSON is zod-validated and merged, never trusted as is. `npm run ai:eval` pins the rules' behaviour — add a case before fixing a misread query.
- **Ranking** is a weighted mean of min-max-normalised signals (service, place/distance, semantic, Bayesian rating, price). Absolute cosine thresholds are meaningless with `gemini-embedding-2` (unrelated salons score ~0.65), so none exist; the semantic weight is scaled by how much the similarities actually spread. Explicit constraints decide the tier: `best` meets all, `partial` some, `alternative` only when nothing matched. Each result carries typed `reasons` / `missing`.
- **Every AI call is optional.** `generate` returns null instead of throwing, tries `GEMINI_CHAT_MODEL` (comma-separated list) in order, and cools a failing model down. Live-search timeouts use an `AbortSignal`: `httpOptions.timeout` is also sent as `X-Server-Timeout`, which generateContent rejects under 10 s.
- **`gemini-embedding-2` takes no `task_type`** (the API silently ignores it). Queries are embedded as `task: search result | query: …`, documents as `title: … | text: …`; `task_type` is only sent to older models.

`Salon.embedding` is `Unsupported("vector(768)")`, so all vector reads and writes are raw SQL. Each vector carries `embeddingModel`, `embeddingHash` ("<DOCUMENT_VERSION>:<sha256>") and `embeddedAt`. Salon and service writes call `scheduleReindex` (debounced, never throws), and the `ai.syncIndex` job (every 10 min, 45 s after boot) re-embeds anything missing, stale, from another model or from an older `DOCUMENT_VERSION`; unchanged salons cost no Gemini call. So after changing `buildSalonDocument`, bump `DOCUMENT_VERSION`; after changing `GEMINI_EMBEDDING_MODEL`, do nothing — both re-embed on their own. `npm run backfill:embeddings` (`-- --all` to force) does it immediately; `npm run ai:diagnose` prints coverage and runs live queries; `GET /ai/status` (ADMIN) reports coverage.

The HNSW index (`salons_embedding_hnsw`) is hand-written SQL (Prisma cannot express an index on an `Unsupported` column). `prisma db push` silently drops it — it went missing once that way — so apply schema changes with `migrate deploy`; `20260923000000_ai_search_index_metadata` re-creates it idempotently.

Env (read through `config.ai` / `config.internalApiKey`): `GEMINI_API_KEY`, `GEMINI_EMBEDDING_MODEL` (default `gemini-embedding-2`), `GEMINI_CHAT_MODEL` (default `gemini-2.5-flash,gemini-3.5-flash-lite`), `AI_SEARCH_LIMIT`, `INTERNAL_API_KEY`.

## Booking concurrency

Appointments are booked against a pre-generated `Slot`, never a raw time. `bookAppointment` validates the slot, then inside a transaction claims it with `updateMany({ where: { id, status: "AVAILABLE", isBooked: false } })` and treats `count === 0` as a 409 — that conditional update is the only thing preventing double booking, so keep it if you touch the flow. Slots are produced in bulk by `POST /slots/bulk-create` (start/end/duration/breakDuration, with conflict detection against existing slots). `counterId` is required on an appointment; `staffId` is optional but must belong to the salon.

## Rate limiting

`authLimiter` (10 / 15 min / IP) guards every credential and token endpoint; `aiSearchLimiter` (15 / min) guards `POST /ai/search` because each call can spend Gemini quota up to three times; `paymentLimiter` (20 / 15 min / account) guards the wallet, payment and assistant top-up routes, mounted after `auth(...)`. All live in `src/app/middlewares/rateLimiter.ts`.

The frontend calls this API from its own server, so for every visitor `req.ip` is the Vercel function's address. `aiSearchLimiter`, `assistantLimiter` and `paymentLimiter` therefore key on `userOrClientKey`: the account when `auth()`/`optionalAuth()` ran first, else `clientIp(req)` — the `X-Client-IP` the Next.js server forwards, trusted only with a matching `X-Internal-Key` (`INTERNAL_API_KEY`, same value on both hosts). `authLimiter`, `mapLimiter` and `geoLimiter` still key on `req.ip` and share the problem: their routes are public (or, for `/auth/change-email`, run the limiter before `auth`), so only the `clientIp` half of `userOrClientKey` would apply, and that needs `INTERNAL_API_KEY` forwarding on those calls first.

`req.ip` (used directly, and as `clientIp`'s fallback) only resolves to the real client because `src/app.ts` sets `trust proxy` to `1` — Render forwards over plain HTTP and puts the client in `X-Forwarded-For`. Without it every visitor shares one bucket and express-rate-limit logs `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` on every request. Keep it at `1` (one hop); `true` would let a client spoof the header and get a fresh bucket per request.

## Email

One entry point, `sendEmail(to, subject, html)` in `src/app/utils/emailSender.ts`, over a provider interface in `src/app/utils/email/`: `resend.provider.ts` (HTTPS API) and `smtp.provider.ts` (nodemailer). `EMAIL_PROVIDER` pins one; left empty, the first provider with credentials wins, which prefers Resend.

**Production cannot use SMTP here.** Render blocks outbound port 587, so nodemailer fails with `ETIMEDOUT` and then `ENETUNREACH` on the IPv6 fallback — an HTTPS API on 443 is the only transport that gets out. SMTP is for local development. `EMAIL_FROM` must be an address on a domain verified with the provider.

`npm run test:email -- you@example.com` sends one real email and reports which provider handled it; run it on the deployed host before debugging anything else. `EMAIL_SETUP.md` is the full setup and troubleshooting guide.

## Environment

`src/config/index.ts` loads `.env` from `process.cwd()` and exposes `env`, `port`, `database_url`, `frontend_url`, `jwt.*`, `cloudinary.*`, `email.*`, `sslcz.*`, `geo.*`, `ai.*` and `internalApiKey`. `NODE_ENV` is still read directly from `process.env` in cookie and error-stack logic.

Cloudinary credentials are wired into config but **no upload code exists yet** — `multer` and `cloudinary` are installed and unused. Image fields (`Salon.images`, `User.profilePhoto`) are plain URL strings supplied by the client.
