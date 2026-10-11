# Owner access inventory (Owner Phase 0)

Every place the backend decides "may this owner touch this salon/booking" today, and
the `OwnerPermission` Phase 1 should check there through `utils/salonAccess.ts`
(`assertSalonPermission` / `accessibleSalonIds` / `scopeSalonIds` / `assertOwnerOf`).

Source greps (re-run them to refresh this file):

```
grep -rn "salonOwner.findUnique\|ownedSalonIds\|assertCanActOnAppointment" src/app/modules --include=*.ts
grep -rn "auth(" src/app/modules --include=*.routes.ts --include=*.route.ts
```

Today's helpers (`utils/salonAccess.ts`): `ownedSalonIds(userId)` lists the owner's salons;
`assertCanActOnAppointment(userId, role, salonId, msg?)` lets ADMIN through, an owner on
their own salon, STAFF on the salon they work at, and otherwise throws **403**.
Phase 1 replaces cross-business refusals with **404 "Not found"**.

## 1. Call sites

"Rule" is what the code does now. `—` in the permission column = not an owner-access
check (admin tool or owner application); leave as is.

| # | file:line | function | Current rule | Phase 1 permission |
|---|---|---|---|---|
| 1 | Admin/users/users.privacy.ts:120 | buildExport | admin data export reads the user's owner profile | — |
| 2 | Admin/users/users.service.ts:420 | getImpact | admin impact preview lists the user's ACTIVE salons | — |
| 3 | AI-Suggestion/ai.controller.ts:58 | generateEmbedding | non-admin must have the salon in `ownedSalonIds`, else 403 | branch.profile |
| 4 | Appointment/appointment.checkout.ts:126 | loadForCounter | `assertCanActOnAppointment` (admin / owner / staff of salon), 403 | bookings.manage |
| 5 | Appointment/appointment.checkout.ts:186 | lookupByToken | `assertCanActOnAppointment`, failure mapped to 404 | bookings.view |
| 6 | Appointment/appointment.checkout.ts:301 | checkout | `assertCanActOnAppointment`, 403 | bookings.manage |
| 7 | Appointment/appointment.checkout.ts:406 | cashSummary | with `salonId`: `assertCanActOnAppointment`; else owner → all `ownedSalonIds` | money.view (scopeSalonIds) |
| 8 | Appointment/appointment.checkout.ts:409 | cashSummary | owner without `salonId` → every owned salon | money.view (accessibleSalonIds) |
| 9 | Appointment/appointment.service.ts:719 | bookWalkIn | `assertCanActOnAppointment` on the slot's salon, 403 | walkin.create |
| 10 | Appointment/appointment.service.ts:893 | getAllAppointments | owner → `where salonId in owner.salons` | bookings.view (scopeSalonIds) |
| 11 | Appointment/appointment.service.ts:1188 | canViewAppointment | owner sees it when `salon.ownerId === owner.id` | bookings.view |
| 12 | Appointment/appointment.service.ts:1266 | updateAppointmentStatus | owner must own the salon, else 403 | bookings.manage |
| 13 | Appointment/appointment.service.ts:1475 | cancelAppointment | owner must own the salon, else 403 | bookings.manage |
| 14 | BecomeASalonWoner/salonOwner.service.ts:40 | applySalonOwner | one application per user | — |
| 15 | BecomeASalonWoner/salonOwner.service.ts:69 | getMySalonOwnerApplication | own application by `userId` | — |
| 16 | BecomeASalonWoner/salonOwner.service.ts:139 | getApplicationById | admin read by id | — |
| 17 | BecomeASalonWoner/salonOwner.service.ts:157 | approveApplication | admin action by id | — |
| 18 | BecomeASalonWoner/salonOwner.service.ts:198 | rejectApplication | admin action by id | — |
| 19 | Counter/counter.service.ts:6 | createCounter | `findUniqueOrThrow` owner, then salon must be owner's | counters.manage |
| 20 | DashboardStats/dashboardStats.service.ts:133 | getSalonOwnerDashboardStats | aggregates over every owned salon (no `salonId`) | reports.view (scopeSalonIds) |
| 21 | Payment/payment.service.ts:49 | createPayment | `assertCanActOnAppointment`, 403 | bookings.manage |
| 22 | Payment/payment.service.ts:120 | getAllPayments | owner → payments of `ownedSalonIds` | money.view (accessibleSalonIds) |
| 23 | Payment/payment.service.ts:187 | getPaymentById | owner → 404 unless salon in `ownedSalonIds` | money.view |
| 24 | Payment/payment.service.ts:211 | updatePaymentStatus | `assertCanActOnAppointment`, 403 | bookings.manage |
| 25 | Salon/salon.service.ts:36 | createSalon | must have an owner profile | branch.create (assertOwnerOf) |
| 26 | Salon/salon.service.ts:285 | getMySalons | lists the owner's salons; 404 without profile | (accessibleSalonIds, any perm) |
| 27 | Salon/salon.service.ts:471 | updateSalon | owner profile + `salon.ownerId` match, 403 | branch.profile (policy.manage for policy fields) |
| 28 | Salon/salon.service.ts:538 | updateSalonLocation | owner profile + `salon.ownerId` match, 403 | branch.location |
| 29 | Salon/salon.service.ts:594 | deleteSalon | `salon.ownerId === owner.id`, else 403 | branch.create (owner only) |
| 30 | Service/service.service.ts:19 | createService | owner profile + salon is owner's | services.edit |
| 31 | Service/service.service.ts:152 | updateService | owner profile + service's salon is owner's | services.edit (services.toggle for `isActive` only) |
| 32 | Service/service.service.ts:194 | deleteService | owner profile + service's salon is owner's | services.edit |
| 33 | Service/service.service.ts:236 | getMyServices | services of every owned salon | services.toggle (scopeSalonIds) |
| 34 | Settlement/settlement.service.ts:652 | getMyPayouts | payouts of every owned salon | money.view |
| 35 | Settlement/settlement.service.ts:735 | getMyEarnings | earnings of every owned salon | money.view |
| 36 | Slot/slot.service.ts:50 | bulkCreateSlots | owner profile + salon is owner's, 404/403 | slots.manage |
| 37 | Slot/slot.service.ts:406 | updateSlotStatus | `slot.salon.ownerId === owner.id`, 403 | slots.manage |
| 38 | Slot/slot.service.ts:440 | deleteSlot | `slot.salon.ownerId === owner.id`, 403 | slots.manage |
| 39 | Slot/slot.service.ts:464 | deleteBulkSlots | owner profile + salon is owner's | slots.manage |
| 40 | Staff/staff.service.ts:8 | addStaff | owner profile by `userId` + salon is owner's | team.invite |
| 41 | Staff/staff.service.ts:231 | updateStaff | owner profile by **owner id** + staff's salon is owner's | team.invite |
| 42 | Staff/staff.service.ts:308 | removeStaff | owner profile by **owner id** + staff's salon is owner's | team.invite |
| 43 | User/user.service.ts:70 | getMyCustomers | customers who booked any owned salon | customers.view (scopeSalonIds) |

## 2. Routes (owner-relevant modules)

| Route | Roles today | Phase 1 permission |
|---|---|---|
| POST /appointments | CUSTOMER | — |
| POST /appointments/walk-in | SALON_OWNER, STAFF | walkin.create |
| GET /appointments | ADMIN, SALON_OWNER, STAFF, CUSTOMER | bookings.view |
| GET /appointments/my-appointments | CUSTOMER | — |
| GET /appointments/lookup | ADMIN, SALON_OWNER, STAFF | bookings.view |
| GET /appointments/cash-summary | ADMIN, SALON_OWNER | money.view |
| GET /appointments/:id | ADMIN, SALON_OWNER, STAFF, CUSTOMER | bookings.view |
| PATCH /appointments/:id/check-in | ADMIN, SALON_OWNER, STAFF | bookings.manage |
| PATCH /appointments/:id/start | ADMIN, SALON_OWNER, STAFF | bookings.manage |
| POST /appointments/:id/checkout | ADMIN, SALON_OWNER, STAFF | bookings.manage |
| PATCH /appointments/:id/status | ADMIN, SALON_OWNER, STAFF, CUSTOMER | bookings.manage |
| GET /appointments/:id/cancellation-preview | CUSTOMER | — |
| POST /appointments/:id/appeal | CUSTOMER | — |
| PATCH /appointments/:id/appeal | adminAuth(appeals.resolve) | — |
| DELETE /appointments/:id | CUSTOMER, SALON_OWNER | bookings.manage |
| POST /counters | SALON_OWNER | counters.manage |
| GET /counters | SALON_OWNER, ADMIN | counters.manage ¹ |
| GET /counters/:id | SALON_OWNER, ADMIN | counters.manage ¹ |
| GET /dashboard-stats/salon-owner | SALON_OWNER | reports.view |
| POST /payments | ADMIN, SALON_OWNER | bookings.manage |
| GET /payments | ADMIN, SALON_OWNER | money.view |
| GET /payments/:id | ADMIN, SALON_OWNER, CUSTOMER | money.view |
| PATCH /payments/:id/status | ADMIN, SALON_OWNER (+ step-up for staff roles) | bookings.manage |
| GET /payments/methods | all signed-in | — |
| POST /reviews/:id/report | CUSTOMER, SALON_OWNER | reviews.reply |
| GET /reviews, /reviews/salon/:id, /reviews/staff/:id, /reviews/:id | public | — |
| POST /salons | SALON_OWNER | branch.create |
| GET /salons/my-salons | SALON_OWNER | (any perm) |
| PATCH /salons/:id | SALON_OWNER | branch.profile / policy.manage |
| PATCH /salons/:id/location | SALON_OWNER | branch.location |
| DELETE /salons/:id | SALON_OWNER | branch.create (owner only) |
| PATCH /salons/:id/status | adminAuth(salons.view) | — |
| POST /services | SALON_OWNER | services.edit |
| GET /services/my-services | SALON_OWNER | services.toggle |
| PATCH /services/:id | SALON_OWNER | services.edit / services.toggle |
| DELETE /services/:id | SALON_OWNER | services.edit |
| GET /services, /services/:id | public | — |
| POST /slots/bulk-create | SALON_OWNER | slots.manage |
| PATCH /slots/:id/status | SALON_OWNER | slots.manage |
| POST /slots/bulk-delete | SALON_OWNER | slots.manage |
| DELETE /slots/:id | SALON_OWNER | slots.manage |
| GET /slots | public | — |
| POST /staff | SALON_OWNER | team.invite |
| PATCH /staff/:id | SALON_OWNER | team.invite |
| DELETE /staff/:id | SALON_OWNER | team.invite |
| GET /staff, /staff/:id | public | — |
| GET /users/my-customers | SALON_OWNER | customers.view |
| GET /users/:id, PATCH /users/:id | ADMIN, SALON_OWNER, CUSTOMER, STAFF (self-only, fixed in Admin Phase 0) | — |
| GET /settlements/my-payouts | SALON_OWNER | money.view |
| GET /settlements/my-earnings | SALON_OWNER | money.view |
| /settlements/payouts*, /balance/:salonId, /audit/*, /platform-earnings | adminAuth(finance.*) | — |

¹ `CounterService.getAllCounters` / `getCounterById` do **no** ownership check: any owner
can read any salon's counters by `salonId`/id. Low sensitivity (names only), but Phase 1
should scope them with `scopeSalonIds` / `assertSalonPermission`.

Also for Phase 1: `updateStaff` / `removeStaff` look the owner up by `id` (the controller
resolves it), unlike every other service which looks up by `userId`.

## Count

- **43** call sites (grep hits minus 6 import lines) in 13 files.
- **36** are owner-access checks Phase 1 moves to `salonAccess`; 7 are admin/application
  lookups (#1, #2, #14–#18) that stay.
- **38** owner-reachable routes carry a Phase 1 permission.
