# bKash Tokenized Checkout: sandbox UAT evidence

The record bKash's onboarding team asks for: one row per test case, with the
ids from both sides and the `[bkash]` log lines the backend wrote.

- **Environment:** bKash Tokenized Checkout sandbox (`BKASH_IS_LIVE=false`), bKash's
  public sandbox merchant. Backend run locally from `dist/` with
  `DISABLE_BACKGROUND_JOBS=true`, against the project database. Frontend `next dev` on :3000.
- **Customer:** one test CUSTOMER account. Sandbox wallets: `01770618575` (success),
  `01823074817` (insufficient balance), `01823074818` (debit block). OTP `123456`, PIN `12121`.
- **Redaction:** `[bkash]` lines are copied as logged. They never carry a body, header,
  token or wallet number (see `bkash.client.ts`). Customer email addresses in `[email]`
  lines are replaced with `<customer>`.
- **Columns:** `tran` is our `transactionId` (sent to bKash as `merchantInvoiceNumber`),
  `paymentID` is bKash's checkout id (our `sessionKey`), `trxID` is bKash's transaction id
  (our `gatewayRef`, set only on a completed payment).

## Results

| Case | Date (UTC) | tran | bKash paymentID | trxID | Result | `[bkash]` log |
|---|---|---|---|---|---|---|
| U1a Happy path, first try (৳200) | 2026-09-24 16:21 | `TOPUP-1790266866114-1504a02e` | `TR00116QW1s1P1790266877783` | `DIO20PHJ24` (recovered by reconcile) | **Deviated, bug found and fixed.** bKash captured the money; our credit transaction timed out, leaving the intent PENDING and the result page stuck on "Confirming your payment". Reconcile at 17:08 (query `Completed`) credited it once, with a receipt email: see notes | `[bkash] token source=db expiresAt=2026-09-24T16:48:57.418Z`<br>`[bkash] {"op":"create","tran":"TOPUP-1790266866114-1504a02e","ms":3215,"code":"0000","trxStatus":"Initiated"}`<br>`[bkash] {"op":"execute","tran":"TOPUP-1790266866114-1504a02e","ms":1242,"code":"0000","trxStatus":"Completed"}`<br>`[payment.bkash] callback settle failed for intent=20cdd6af-…: Transaction API error: Transaction not found. …`<br>17:08 reconcile: `[bkash] {"op":"query","tran":"TOPUP-1790266866114-1504a02e","ms":417,"code":"0000","trxStatus":"Completed"}`<br>`[email] sent "Payment receipt - ৳200 added to your wallet" to <customer> via resend (01a0d463-d4bb-…)` |
| U1 Happy path (৳2,000, `01770618575`) | 2026-09-24 16:24 | `TOPUP-1790267050198-13e1a556` | `TR00111U6Nev11790267058909` | `DIO20PHJNS` | **Pass.** Success page with TrxID, wallet +৳2,000 (678,400 → 878,400 poisha), exactly 1 TOPUP row, receipt email sent | `[bkash] {"op":"create","tran":"TOPUP-1790267050198-13e1a556","ms":411,"code":"0000","trxStatus":"Initiated"}`<br>`[bkash] {"op":"execute","tran":"TOPUP-1790267050198-13e1a556","ms":1173,"code":"0000","trxStatus":"Completed"}`<br>`[email] sent "Payment receipt - ৳2,000 added to your wallet" to <customer> via resend (01a0d43b-…)` |
| U2 Cancel on bKash's page (৳210) | 2026-09-24 16:42 | `TOPUP-1790268145310-09da8831` | `TR0011a3LoAKW1790268158970` | none | **Pass.** Cancelled page; intent CANCELLED "You cancelled the bKash payment."; wallet unchanged | `[bkash] {"op":"token.refresh","ms":676,"code":"0000"}`<br>`[bkash] token source=refresh expiresAt=2026-09-24T17:42:28.553Z`<br>`[bkash] {"op":"create","tran":"TOPUP-1790268145310-09da8831","ms":5349,"code":"0000","trxStatus":"Initiated"}`<br>`[bkash] {"op":"query","tran":"TOPUP-1790268145310-09da8831","ms":429,"code":"0000","trxStatus":"Initiated"}` |
| U3 Insufficient balance, `01823074817` (৳220) | 2026-09-24 16:43 | `TOPUP-1790268196057-d7fc16fd` | `TR0011QTsA6vA1790268204891` | none | **Pass, with the expected deviation.** Failed page; intent FAILED; wallet unchanged. The reason is "The bKash payment did not complete.", not the 2023 sentence: see notes | `[bkash] {"op":"create","tran":"TOPUP-1790268196057-d7fc16fd","ms":523,"code":"0000","trxStatus":"Initiated"}`<br>`[bkash] {"op":"query","tran":"TOPUP-1790268196057-d7fc16fd","ms":434,"code":"0000","trxStatus":"Initiated"}` |
| U4 Debit block, `01823074818` (৳230) | 2026-09-24 16:44 | `TOPUP-1790268263870-16fbd6b4` | `TR00110HIqFmv1790268272379` | none | **Pass.** Failed page; intent FAILED, reason "The bKash payment did not complete." stored; wallet unchanged. Same shape as U3 | `[bkash] {"op":"create","tran":"TOPUP-1790268263870-16fbd6b4","ms":428,"code":"0000","trxStatus":"Initiated"}`<br>`[bkash] {"op":"query","tran":"TOPUP-1790268263870-16fbd6b4","ms":443,"code":"0000","trxStatus":"Initiated"}` |
| U5 Wrong OTP/PIN, `01770618575` (৳240, redone at ৳500) | 2026-09-24 16:45 and 17:02 | `TOPUP-1790268316592-b4b767c5`<br>`TOPUP-1790269361100-327d4b28` | `TR0011e2KedXa1790268325095`<br>`TR0011ALxwIck1790269369892` | `DIO80PHJ2K`<br>`DIO20PHJP6` | **Pass with explanation: bKash handles it on its own page.** A wrong OTP shows "Wrong verification code" and a wrong PIN "Wrong PIN" inline, with retry (tester screenshots). No callback reaches us until the payment ends. Both runs ended with the correct PIN, so bKash completed them and each was credited exactly once. A lockout was not reached in the sandbox. See notes | 1st: `[bkash] {"op":"execute","tran":"TOPUP-1790268316592-b4b767c5","ms":1440,"code":"0000","trxStatus":"Completed"}`<br>2nd: `[bkash] {"op":"create","tran":"TOPUP-1790269361100-327d4b28","ms":480,"code":"0000","trxStatus":"Initiated"}`<br>`[bkash] {"op":"execute","tran":"TOPUP-1790269361100-327d4b28","ms":1470,"code":"0000","trxStatus":"Completed"}`<br>(no log line for the wrong OTP/PIN attempts: they never leave bKash) |
| U6 Replay U1's callback 3× | 2026-09-24 16:27 | `TOPUP-1790267050198-13e1a556` | `TR00111U6Nev11790267058909` | `DIO20PHJNS` | **Pass.** All three 302 to the success page; still 1 TOPUP row, balance unchanged, no second email | none: an intent already SUCCESS returns before any bKash call |
| U7 Browser never returns (৳350) | 2026-09-24 16:37, reconciled 17:08 | `TOPUP-1790267861427-409209bd` | `TR0011Hd7HQfL1790267872607` | none | **Pass: execute is the capture.** Backend stopped 10 s after create (16:37:55); the tester finished OTP+PIN; bKash redirected with `status=success` to the dead backend; the tab was closed unreloaded. After a restart, `POST /payments/admin/reconcile` queried it: `Initiated`. Intent still PENDING, wallet unchanged | `[bkash] {"op":"create","tran":"TOPUP-1790267861427-409209bd","ms":2868,"code":"0000","trxStatus":"Initiated"}`<br>(backend down: no callback, no execute)<br>`[bkash] {"op":"query","tran":"TOPUP-1790267861427-409209bd","ms":410,"code":"0000","trxStatus":"Initiated"}`<br>`[payment.reconcile] checked 4 stale intents: 2 credited, 0 failed` |
| U7 first try (৳300) | 2026-09-24 16:31, reconciled 17:08 | `TOPUP-1790267462828-94ba2f17` | `TR0011XUeQTb11790267473105` | none | **Not a valid U7 run.** bKash itself redirected with `status=failure` (to the stopped backend), so the customer never authorised it. Query `Initiated`, still PENDING, wallet unchanged. Redone as the row above | `[bkash] {"op":"create","tran":"TOPUP-1790267462828-94ba2f17","ms":1964,"code":"0000","trxStatus":"Initiated"}`<br>`[bkash] {"op":"query","tran":"TOPUP-1790267462828-94ba2f17","ms":430,"code":"0000","trxStatus":"Initiated"}` |
| U8 Forged unknown paymentID | 2026-09-24 16:46 | none | `bogus` | none | **Pass.** 302 to the failed page; no intent touched; no bKash call | `[payment.bkash] callback for an unknown paymentID "bogus"` (and no `[bkash]` line) |
| U9 Forged `status=success` on an unpaid paymentID (৳250) | 2026-09-24 16:50 | `TOPUP-1790268635587-626e8d04` | `TR0011ENDWKME1790268644614` | none | **Pass.** No credit (wallet unchanged). Execute was refused with bKash 2056; the query said `Initiated`, so the intent stays PENDING. Browser sent to the success page, which polls "Confirming your payment" | `[bkash] {"op":"create","tran":"TOPUP-1790268635587-626e8d04","ms":431,"code":"0000","trxStatus":"Initiated"}`<br>`[bkash] {"op":"execute","tran":"TOPUP-1790268635587-626e8d04","ms":425,"code":"2056"}`<br>`[bkash] {"op":"query","tran":"TOPUP-1790268635587-626e8d04","ms":424,"code":"0000","trxStatus":"Initiated"}` |
| U10 Amount/invoice tamper | 2026-09-24 | n/a | n/a | n/a | **Pass (offline, by design: no live-DB edits).** Covered by the 4.1 checks: `verifyBkashSettlement` refuses a wrong amount, a wrong invoice, a non-BDT currency and an `Initiated` status. A refusal on a real execute is logged as `possible tampering` and marks the intent FAILED | n/a |
| U11 Token survives restarts: 5 restarts in 68 s, one top-up each (admin account, ৳100, cancelled via the callback) | 2026-09-24 17:09–17:10 | `TOPUP-1790269767495-0a2fa855`<br>`TOPUP-1790269780799-b990d2c4`<br>`TOPUP-1790269794123-970eea53`<br>`TOPUP-1790269807498-7453073c`<br>`TOPUP-1790269822473-457add7e` | (5 ids, in the DB) | none | **Pass.** Every fresh process read the stored token from the database (`source=db`); zero grants. Whole session: 9 backend starts, 8 × `source=db`, 1 × `source=refresh` (the token expired at 16:48; refreshed at 16:41 within the safety margin), 0 × `source=grant`, no `token.grant` call | each round:<br>`[bkash] token source=db expiresAt=2026-09-24T17:42:28.553Z`<br>`[bkash] {"op":"create","tran":"TOPUP-1790269767495-0a2fa855","ms":1856,"code":"0000","trxStatus":"Initiated"}`<br>`[bkash] {"op":"query","tran":"TOPUP-1790269767495-0a2fa855","ms":283,"code":"0000","trxStatus":"Initiated"}` |
| U12 SSLCommerz regression (৳200) | 2026-09-24 16:58 | `TOPUP-1790269130337-fce665f1` | n/a (SSLCommerz session `5786C8CB2234CE8976E7EA3DF3AA9E12`) | SSLCommerz `260924225903QYel0UMhzKuchnR` | **Pass.** Success page "Paid via SSLCommerz"; intent SUCCESS, provider SSLCOMMERZ, method `BKASH-BKash` (bKash chosen inside SSLCommerz's sandbox); 1 TOPUP row; receipt email sent by the local backend | no `[bkash]` line (SSLCommerz path)<br>`[email] sent "Payment receipt - ৳200 added to your wallet" to <customer> via resend (01a0d45b-6c9b-…)` |
| U13 Kill switch, `BKASH_ENABLED=false` + restart | 2026-09-24 17:10–17:12 | none | none | none | **Pass.** `GET /payments/methods` lists bKash `enabled=false`; the top-up dialog shows only "Card, Nagad, Rocket & more" (tester screenshot); `POST /wallet/topup {"amount":100,"provider":"BKASH"}` → **503** "bKash is not available right now", no intent, no bKash call. Re-enabled and restarted at 17:12 | none: no `[bkash]` line after the `BKASH_ENABLED=false` start |
| U14 Duplicate: 2× ৳500 from `01770618575` within ~70 s | 2026-09-24 16:52–16:53 | 1st `TOPUP-1790268753604-b680963a`<br>2nd `TOPUP-1790268822764-feb553e4` | 1st `TR0011sCqfMTt1790268762379`<br>2nd `TR0011dwUqaUI1790268831261` | 1st `DIO90PHJ2V`<br>2nd none | **Pass (enforced in sandbox).** 1st credited ৳500. 2nd: execute refused with 2029, intent FAILED "bKash blocked this as a repeat of a payment you just made. Wait a couple of minutes and try again. (bKash 2029)", failed page, no credit | `[bkash] {"op":"execute","tran":"TOPUP-1790268753604-b680963a","ms":1449,"code":"0000","trxStatus":"Completed"}`<br>`[bkash] {"op":"create","tran":"TOPUP-1790268822764-feb553e4","ms":409,"code":"0000","trxStatus":"Initiated"}`<br>`[bkash] {"op":"execute","tran":"TOPUP-1790268822764-feb553e4","ms":815,"code":"2029"}` |
| U15a Admin refund ৳200 of a ৳500 top-up (P2's) | 2026-09-24 17:23 | `TOPUP-1790264935044-8f4bb44d` | `TR00113EI0Nnc1790264946252` | `DIO10PHJ0Z`<br>refund `DIO70PHJ3N` | **Pass.** 200, `status: COMPLETED`, `remaining: 300`. One TOPUP_REVERSAL −20,000 "Refund to bKash" (key `refund:<intent>:1`), stored as `rawResponse.refunds[0]` with the refund TrxID | `[bkash] {"op":"refund","tran":"DIO10PHJ0Z","ms":3538,"code":"0000","trxStatus":"Completed"}` |
| U15b Refund the rest (no amount → ৳300), by intent id | 2026-09-24 17:23 | same | same | `DIO10PHJ0Z`<br>refund `DIO90PHJ3P` | **Pass.** 200, `refunded: 300`, `remaining: 0`. Second TOPUP_REVERSAL −30,000 (key `…:2`); wallet 1,117,400 → 1,067,400 poisha, i.e. exactly the ৳500 the top-up credited is gone; both refund TrxIDs in `rawResponse.refunds[]` | `[bkash] {"op":"refund","tran":"DIO10PHJ0Z","ms":1588,"code":"0000","trxStatus":"Completed"}` |
| U15c Third refund on the same top-up (৳1) | 2026-09-24 17:23 | same | same | n/a | **Pass.** **400** "This top-up has already been refunded in full"; no ledger row | none (still 2 refund lines) |
| U15d Refund ৳500 while available is ৳494 | 2026-09-24 17:24 | `TOPUP-1790268753604-b680963a` (U14's 1st) | `TR0011sCqfMTt1790268762379` | `DIO90PHJ2V` | **Pass.** Admin adjust −৳10,000 (available 1,049,400 → 49,400), then the refund: **400** "Insufficient available balance", refused by `WalletService.mutate` inside the reservation, so the transaction rolled back (0 TOPUP_REFUND rows on that intent) and bKash was never called. Adjust +৳10,000 reversed it (balance back to 1,067,400) | none (refund lines before 2, after 2) |
| U16 Mobile, 360 px (৳450) | 2026-09-24 16:56 | `TOPUP-1790269006573-c60600cc` | `TR0011PREHsSG1790269015095` | `DIO60PHJOQ` | **Pass.** Dialog, bKash page and result page usable at 360 px with no horizontal scroll (checked by the tester); ৳450 credited once, receipt email sent | `[bkash] {"op":"create","tran":"TOPUP-1790269006573-c60600cc","ms":432,"code":"0000","trxStatus":"Initiated"}`<br>`[bkash] {"op":"execute","tran":"TOPUP-1790269006573-c60600cc","ms":1627,"code":"0000","trxStatus":"Completed"}`<br>`[email] sent "Payment receipt - ৳450 added to your wallet" to <customer> via resend (01a0d459-…)` |
| U17a Admin screen: sidebar link + search `DIO10PHJ0Z` (Phase 5.5) | 2026-09-25 14:05 | `TOPUP-1790264935044-8f4bb44d` | n/a | `DIO10PHJ0Z`<br>refunds `DIO70PHJ3N`, `DIO90PHJ3P` | **Pass.** As `admin@salon.com` the sidebar shows "Top-ups & Refunds"; the row reads ৳500, Refunded ৳500, "Fully refunded", Refund disabled ("already been refunded in full"), and expands to #1 ৳200 and #2 ৳300, both Completed, with both refund TrxIDs. API: `refundedMinor: 50000`, `remainingMinor: 0` | none (read only) |
| U17b No `rawResponse` / `payerAccount` leaves the server | 2026-09-25 14:05 | same | n/a | same | **Pass.** Neither string appears in the `GET /payments/admin/intents` JSON (9 filter variants), the page HTML, the RSC payload or the DOM | none |
| U17c Filters, paging, validation | 2026-09-25 14:10 | n/a | n/a | n/a | **Pass.** Default = SUCCESS (49); `ALL` 76; `provider=sslcommerz` + `status=all` (case-insensitive) 37; BKASH+CANCELLED 11; email/name search; `limit=100` clamped to 50; `status=NOPE` / `provider=PAYPAL` → **400**. UI: the Method select pushes `?provider=BKASH` and resets `page=2` to 1; search submits on Enter into `?q=` | none |
| U17d CUSTOMER: no link, `GET /payments/admin/intents` → 403 | | | | | **Not run.** Needs a customer session; Claude does not enter passwords | |
| U17e Refund ৳100 of a SUCCESS bKash top-up from the dialog | | | | | **Not run.** Needs the user's go; Claude's auto mode also blocked filling the refund form | |
| U17f Over-remaining amount blocked; server refusal shown inline | | | | | **Not run.** Same block. Dialog opened on `DIO40PHJ44` (৳200) showed the summary correctly; cancelled with nothing sent | |
| U17g 360 px, and `GET /wallet/admin/drift` unchanged | | | | | **Not run** | |

## Notes per case

**U1a: captured but not credited (fixed).** The execute call returned `Completed`,
so bKash had taken the money. `creditSettledIntent` then ran its wallet credit in a
Prisma interactive transaction with the default 5 s timeout. The database was slow
at that moment (a plain read took 7.5 s), the transaction expired mid-credit, and the
callback fell into its "leave it PENDING" branch. Nothing was lost, since the intent
stays open for reconciliation, but the result page's poll is a pure read and
reconciliation only takes intents older than 30 minutes. So the customer watched
"Confirming your payment" for at least half an hour.
Fix: that transaction now uses the same budget as `WalletService` (`maxWait: 10_000,
timeout: 15_000`) in `paymentIntent.service.ts`. The backend was rebuilt and restarted
at 16:27. U1 (16:24) still ran on the old build and passed because the database answered
in time. Every other case ran on the fixed build, and the 17:08 reconcile credit of U1a
went through that fixed transaction.

The same reconcile run also credited a Phase 3 browser check from 16:01
(`TOPUP-1790265699805-f9e7ed7b`, ৳200, trxID `DIO10PHJ19`), which had sat PENDING. bKash's
query said `Completed`, so an execute had succeeded. That run was on the old dev server,
before the fix, and its log isn't available. It was most likely the same timeout.

**U7: why the query decides the design.** bKash answered `Initiated` more than 30 minutes
after the customer entered their PIN on a payment we never executed. So the customer's
authorisation alone moves no money, and a callback that never arrives cannot leave
money in limbo. Only our execute captures. Had the query said `Completed`, bKash would
be capturing without us, and the design would have needed revisiting before go-live.

**U3 / U4: no bKash error code reaches us.** The sandbox refuses an insufficient-balance
or debit-blocked wallet on bKash's own page. It then sends the browser back with
`status=failure`, and we never call execute. The query still says `Initiated` and carries
no `errorCode`, so there is no code to turn into "(bKash 2023)". The customer gets the
generic "The bKash payment did not complete." This is by design: a failure callback is
never trusted on its own, and a status query cannot report a code bKash never assigned.
The 2023 sentence is still mapped (`bkash.errors.ts`) and checked offline (4.1) for the
case where execute itself returns 2023.

**U5: wrong OTP/PIN never leaves bKash.** bKash validates the OTP and PIN on its hosted
page. It shows "Wrong verification code" / "Wrong PIN" and lets the customer retry, with
no redirect and no call to us. The merchant only learns the final outcome through the
callback: `success`, then our execute and verification, or `failure`/`cancel`, then our
query, as U2–U4 show. In both runs the tester entered the correct PIN after the errors,
so the payment completed and was credited once. The sandbox did not lock the wallet in
the attempts made. A lockout would come back as `status=failure` and take the U3/U4 path
(query → FAILED, wallet unchanged).

**U9: PENDING, not FAILED.** bKash answers an execute on an unauthorised paymentID with
2056 ("invalid payment state"). We classify 2056 as `ambiguous` on purpose: the same code
can come back from a retried execute of a payment that did go through. So we ask
bKash (query → `Initiated`) and leave the intent open instead of writing it off. The
bKash code is in the `[bkash]` log line rather than in `failureReason`, because the intent
has not failed yet. Reconciliation keeps it PENDING while bKash says `Initiated` and marks
it EXPIRED once the paymentID is 24 h old. A forger gains a spinner, not money.

**Other runs in the session (not matrix cases).** Between U14 and U12 the tester made
two cancelled bKash attempts (`TOPUP-1790268895801-91e9a6c5` ৳200,
`TOPUP-1790268953765-464f37d8` ৳500: create, then query `Initiated`, then CANCELLED) and
one paid ৳100 bKash top-up (`TOPUP-1790269095738-c1391e7c`, trxID `DIO00PHJOU`, credited
once). The wallet reconciles exactly: 902,400 + 50,000 (U14) + 45,000 (U16) + 10,000 +
20,000 (U12) = 1,027,400 poisha. After the U5 redo (+50,000) and the 17:08 reconcile
(+20,000 U1a, +20,000 Phase 3 check) it is 1,117,400 poisha, and every credited intent
has exactly one TOPUP ledger row.

**U15: refunds (Phase 5).** `POST /payments/admin/intents/:id/refund` as `admin@salon.com`,
backend from `ts-node-dev` on :5055 with `DISABLE_BACKGROUND_JOBS=true`. Instead of two new
top-ups, the test reused two completed ৳500 bKash sandbox top-ups from earlier the same day (P2's
`DIO10PHJ0Z`, U14's `DIO90PHJ2V`). Each is a completed bKash sandbox payment, like a new one would be. Refund v2 answered on
`{origin}/v2/tokenized-checkout/refund/payment/transaction` at the first try (no 404, so the docs
were not fetched). In refund lines `tran` is the trxID, because the refund is addressed by it.
The gateway-refused path (compensating ADJUSTMENT) and the `UNKNOWN` path were not triggered in
the sandbox. After U15: test customer 1,067,400 poisha, held 18,000. `GET /wallet/admin/drift`
lists one wallet, another customer's, which has been off since a 2026-09-22 top-up (`balanceAfter`
ignores the 9,996,800 already there). Nothing in this phase touched it.

**U17: admin Top-ups & Refunds screen (Phase 5.5).** The brief called these U16, but U16 was
already Phase 4's 360 px case. Checked against the user's own `ts-node-dev` on :5000 and
`next dev` on :3000 (both reload on save), in a browser already signed in as `admin@salon.com`.
The list reads `rawResponse` only for `refunds[]` (n, amountMinor, refundRef, status, at,
message) and totals refunds from the TOPUP_REFUND ledger rows, so `DIO90PHJ2V` (U15d, refused and
undone) shows "—".

## Offline checks (4.1)

Section 0 of `npm run verify:payments` (`src/scripts/verifyPayments.ts`,
`bkashOfflineChecks`). It runs first, with no database and no network. Result on the final
code, 2026-09-24 17:13: **33 passed, 0 failed** (17 bKash + 16 wallet/SSLCommerz).

| Helper | Checked |
|---|---|
| `parseGatewayAmount` | `"500"` → 50000, `"500.00"` → 50000, `"500.5"` → 50050, `"abc"` → 0 |
| `toGatewayAmount` | 50050 → `"500.50"` |
| `verifyBkashSettlement` | a matching `Completed` payment settles; wrong amount, wrong invoice, currency ≠ BDT and status `Initiated` each refuse (U10) |
| `classifyBkashError` | 2023 → business, 2062 → ambiguous, TIMEOUT → ambiguous, 2002 → integration, 9999 → unknown |
| `bkashFailureReason` | `("2023", …)` ends with `(bKash 2023)` |
| `maskMsisdn` | `"01770618575"` does not contain `0618` |

## Hardening pass (4.3)

- **Secrets never reach a log.** `grep -rn "id_token\|app_secret\|appSecret\|password"
  src/app/modules/Payment` finds them only where requests to bKash are built
  (`bkash.client.ts` headers, `bkash.token.ts` grant/refresh bodies), in `redactBkash`'s
  destructure that strips them, in the `isEnabled` config check, and in an SSLCommerz comment.
  The only bKash log lines are `bkashRequest`'s one line per call (`op`, `tran`, `ms`, `code`,
  `trxStatus`) and the token-source line (`source`, `expiresAt`). Controller and service
  errors log `error.message` or an id, never a request body. Confirmed in this session's log:
  no token, secret or wallet number appears.
- **`rawResponse` is redacted.** Every bKash intent credited in this session (U1, U1a, U5 ×2,
  U14, U16, the ৳100 run, the Phase 3 check) stores 15 keys, `customerMsisdn: "017******75"`,
  and no key named like a token, secret or password. Checked read-only in the database,
  not through the API.
- **`.env.example`.** Database URLs, JWT secrets, Cloudinary, Gemini, Resend, SMTP and
  SSLCommerz are placeholders. The bKash block holds bKash's *publicly published* sandbox
  merchant credentials, deliberately (Phase 0), under a comment saying so and that live
  credentials belong only on Render. No live credential is present. Left as is.
- **Fixed during UAT:** the credit transaction timeout (U1a), in `paymentIntent.service.ts`.
