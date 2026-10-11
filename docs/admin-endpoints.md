# Admin endpoint inventory

Produced in admin Phase 0 (2026-10-08) from
`grep -rn "auth(.*ADMIN\|UserRole.ADMIN" src/app/modules --include="*.route*.ts"`.
Phase 1 turns the **Permission** column into `adminAuth(...)` checks. All paths are under `/api/v1`.

Tier: 0 = read · 1 = routine write · 2 = consequential write (reason required) · 3 = dangerous (step-up, later four-eyes).

## Admin-only and admin-path endpoints

| Method + path | File | Roles today | Permission | Tier |
|---|---|---|---|---|
| `GET /users` | `User/user.routes.ts` | ADMIN | users.view | 0 |
| `PATCH /users/:id/status` | `User/user.routes.ts` | ADMIN | users.manage | 2 |
| `PATCH /users/:id/role` | `User/user.routes.ts` | ADMIN | users.role | 3 |
| `DELETE /users/:id` | `User/user.routes.ts` | ADMIN | users.delete | 3 |
| `POST /agents/create` | `Agent/agent.routes.ts` | ADMIN | agents.manage | 2 |
| `GET /agents` | `Agent/agent.routes.ts` | ADMIN | agents.manage | 0 |
| `PATCH /salons/:id/status` | `Salon/salon.routes.ts` | ADMIN, AGENT | salons.review (approve/reject); salons.manage (other statuses) | 1–2 |
| `DELETE /salons/:id` (admin path) | `Salon/salon.routes.ts` | SALON_OWNER, ADMIN | salons.delete | 3 |
| `GET /become-salon-owner/applications` | `BecomeASalonWoner/salonOwner.route.ts` | ADMIN | salons.review | 0 |
| `GET /become-salon-owner/applications/:id` | `BecomeASalonWoner/salonOwner.route.ts` | ADMIN | salons.review | 0 |
| `PATCH /become-salon-owner/applications/:id/approve` | `BecomeASalonWoner/salonOwner.route.ts` | ADMIN | salons.review | 2 |
| `PATCH /become-salon-owner/applications/:id/reject` | `BecomeASalonWoner/salonOwner.route.ts` | ADMIN | salons.review | 2 |
| `GET /dashboard-stats/admin` | `DashboardStats/dashboardStats.routes.ts` | ADMIN | analytics.view | 0 |
| `GET /settlements/platform-earnings` | `Settlement/settlement.routes.ts` | ADMIN | finance.view | 0 |
| `GET /settlements/payouts` | `Settlement/settlement.routes.ts` | ADMIN | finance.view | 0 |
| `GET /settlements/balance/:salonId` | `Settlement/settlement.routes.ts` | ADMIN | finance.view | 0 |
| `GET /settlements/audit/unbalanced` | `Settlement/settlement.routes.ts` | ADMIN | finance.view | 0 |
| `POST /settlements/payouts/run` | `Settlement/settlement.routes.ts` | ADMIN | finance.payouts | 3 |
| `PATCH /settlements/payouts/:id` | `Settlement/settlement.routes.ts` | ADMIN | finance.payouts | 3 |
| `GET /settlements/commission-rules` | `Settlement/settlement.routes.ts` | ADMIN | settings.manage (deprecated in Phase 7) | 3 |
| `POST /settlements/commission-rules` | `Settlement/settlement.routes.ts` | ADMIN | settings.manage (deprecated in Phase 7) | 3 |
| `PATCH /settlements/commission-rules/:id` | `Settlement/settlement.routes.ts` | ADMIN | settings.manage (deprecated in Phase 7) | 3 |
| `POST /wallet/admin/adjust` | `Wallet/wallet.routes.ts` | ADMIN | finance.wallet_adjust | 3 |
| `GET /wallet/admin/drift` | `Wallet/wallet.routes.ts` | ADMIN | finance.view | 0 |
| `POST /payments/admin/reconcile` | `Payment/payment.routes.ts` | ADMIN | finance.reconcile | 2 |
| `GET /payments/admin/intents` | `Payment/payment.routes.ts` | ADMIN | finance.view | 0 |
| `POST /payments/admin/intents/:id/refund` | `Payment/payment.routes.ts` | ADMIN | finance.refunds | 3 |
| `GET /payments` (admin) | `Payment/payment.routes.ts` | ADMIN, SALON_OWNER | finance.view | 0 |
| `PATCH /payments/:id/status` (admin) | `Payment/payment.routes.ts` | ADMIN, SALON_OWNER | finance.payouts | 3 |
| `PATCH /appointments/:id/appeal` | `Appointment/appointment.routes.ts` | ADMIN | appeals.resolve | 2 |
| `GET /appointments` (admin) | `Appointment/appointment.routes.ts` | ADMIN, SALON_OWNER, STAFF, CUSTOMER | bookings.view | 0 |
| `GET /ai/status` | `AI-Suggestion/ai.route.ts` | ADMIN | system.view | 0 |
| `POST /ai/backfill` | `AI-Suggestion/ai.route.ts` | ADMIN | system.operate | 2 |
| `POST /ai/generate/:id` (admin path) | `AI-Suggestion/ai.route.ts` | ADMIN, SALON_OWNER | system.operate | 1 |
| `GET /assistant/stats` | `Assistant/assistant.routes.ts` | ADMIN | analytics.view | 0 |
| `GET /counters` (admin) | `Counter/counter.route.ts` | SALON_OWNER, ADMIN | salons.view | 0 |
| `GET /counters/:id` (admin) | `Counter/counter.route.ts` | SALON_OWNER, ADMIN | salons.view | 0 |

## Found by the grep, not in the Phase 0 mapping — decide in Phase 1

Shared routes where ADMIN is one of several roles. The non-admin branch keeps its ownership checks; the question is only what an admin needs.

| Method + path | File | Roles today | Permission | Tier |
|---|---|---|---|---|
| `GET /users/:id` (admin path; self allowed since Phase 0) | `User/user.routes.ts` | ADMIN, SALON_OWNER, CUSTOMER, STAFF | decide in Phase 1 (users.view?) | 0 |
| `PATCH /users/:id` (admin path; self allowed since Phase 0) | `User/user.routes.ts` | ADMIN, SALON_OWNER, CUSTOMER, STAFF | decide in Phase 1 (users.manage?) | decide in Phase 1 |
| `GET /appointments/lookup` | `Appointment/appointment.routes.ts` | ADMIN, SALON_OWNER, STAFF | decide in Phase 1 (bookings.view?) | 0 |
| `GET /appointments/cash-summary` | `Appointment/appointment.routes.ts` | ADMIN, SALON_OWNER | decide in Phase 1 (finance.view?) | 0 |
| `GET /appointments/:id` | `Appointment/appointment.routes.ts` | ADMIN, SALON_OWNER, STAFF, CUSTOMER | decide in Phase 1 (bookings.view?) | 0 |
| `PATCH /appointments/:id/check-in` | `Appointment/appointment.routes.ts` | ADMIN, SALON_OWNER, STAFF | decide in Phase 1 | decide in Phase 1 |
| `PATCH /appointments/:id/start` | `Appointment/appointment.routes.ts` | ADMIN, SALON_OWNER, STAFF | decide in Phase 1 | decide in Phase 1 |
| `POST /appointments/:id/checkout` | `Appointment/appointment.routes.ts` | ADMIN, SALON_OWNER, STAFF | decide in Phase 1 (moves money) | decide in Phase 1 |
| `PATCH /appointments/:id/status` | `Appointment/appointment.routes.ts` | ADMIN, SALON_OWNER, STAFF, CUSTOMER | decide in Phase 1 (Phase 6 cancel-for-customer?) | decide in Phase 1 |
| `POST /payments` | `Payment/payment.routes.ts` | ADMIN, SALON_OWNER | decide in Phase 1 (finance.payouts?) | decide in Phase 1 |
| `GET /payments/:id` | `Payment/payment.routes.ts` | ADMIN, SALON_OWNER, CUSTOMER | decide in Phase 1 (finance.view?) | 0 |
| `GET /payments/methods` | `Payment/payment.routes.ts` | every signed-in role | none (self-service) — decide in Phase 1 | — |
| `GET /wallet/me`, `/me/transactions`, `/me/topups`, `POST /wallet/topup`, `GET /wallet/topup/:transactionId` | `Wallet/wallet.routes.ts` | every signed-in role | none (own wallet) — decide in Phase 1 | — |
| `DELETE /assistant/conversations`, `POST /assistant/bookings/confirm`, `POST /assistant/payments/topup` | `Assistant/assistant.routes.ts` | CUSTOMER, SALON_OWNER, ADMIN | none (acting as a customer) — decide in Phase 1 | — |
| `/auth/*` (change password, change email, me, sign-in methods) | `Auth/auth.routes.ts` | every signed-in role | none (own account) — decide in Phase 1 | — |
