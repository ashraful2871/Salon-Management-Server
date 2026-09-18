---
description: Scaffold a new API module following this repo's route/controller/service/validation pattern
argument-hint: <ModuleName> (PascalCase, e.g. Promotion)
---

Create a new API module named `$1` under `src/app/modules/$1/`, matching the
existing modules exactly — read `src/app/modules/Salon/` first and mirror its
conventions rather than inventing new ones.

Produce these four files:

- `$1.routes.ts` — an `express.Router()`, handlers guarded with `auth("ROLE", …)`
  (or `optionalAuth()` for public-but-role-aware reads) and
  `validateRequest($1Validation.x)`, exported as `export const $1Routes = router`.
- `$1.controller.ts` — every handler wrapped in `catchAsync`, replying only via
  `sendResponse(res, { statusCode: StatusCodes.X, success: true, message, data })`.
  Read the acting user from `req.user?.userId`.
- `$1.service.ts` — the `prisma` singleton from `../../shared/prisma`, ownership
  and business rules enforced here, failures thrown as
  `new ApiError(StatusCodes.X, "message")`. No repository layer.
- `$1.validation.ts` — Zod schemas wrapping the whole request:
  `z.object({ body: z.object({ … }) })`, exported as `export const $1Validation = { … }`.

Then register the module in `src/app/routes/index.ts` by importing `$1Routes` and
adding an entry to the `moduleRoutes` array.

If the module needs a new Prisma model, add it as its own file under
`prisma/schema/` (the schema is a folder, one domain per file) and put any new
enum in `prisma/schema/enum.prisma`.

Finish by running `npx prisma generate && npm run build` and reporting the result.
