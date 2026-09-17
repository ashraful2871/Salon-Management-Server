# PAYMENT.md — Wallet, SSLCommerz & Deposits

> Part of the plan set. See [PLAN.md](./PLAN.md) for the index and the strategy behind this design.
> **This is your first implementation target.**

---

## The flow, in one picture

```
STEP 1  TOP UP  (occasional — gateway fee paid ONCE, here)
        Customer adds ৳500 via bKash / Nagad / card through SSLCommerz
        Wallet: ৳0 → ৳500

STEP 2  BOOK  (one tap — no gateway, no OTP, no redirect)
        Haircut ৳150 @ Tue 12:30  (off-peak −30% → ৳105)
        Deposit HELD from wallet: ৳30
        Wallet: ৳500 available → ৳470 available, ৳30 held

STEP 3  OUTCOME
        ✅ Showed up      → ৳30 applied to the bill. Pay ৳75 at the salon.
        🔄 Cancelled >2h  → ৳30 released back to available, instantly.
        ❌ No-show        → ৳30 forfeited.  Salon ৳21 / Platform ৳9.
        🏪 Salon cancels  → ৳30 released + ৳20 goodwill credit (salon-funded).
```

**Why a wallet and not a gateway charge per booking:** a gateway redirect for ৳150 takes 60–90 seconds and fails often (OTP timeout, PIN, network). A wallet deduction is one tap and never fails. And a deposit model generates constant small refunds — gateway reversals take 3–10 days in Bangladesh, while a wallet refund is a single ledger row. Conversion and refund speed are the real wins, not the fee percentage.

---

## Non-negotiable rules

Read these once before writing any code. Every one of them exists because breaking it loses real money.

1. **Money is `Int` in poisha.** 1 tk = 100 poisha. `৳150.00` is `15000`. Never `Float` — rounding error compounds through commission splits and your ledger stops balancing.
2. **The ledger is append-only.** `WalletTransaction` rows are never updated or deleted. A correction is a new compensating row.
3. **`Wallet.balance` is a cache.** It must always equal the sum of its transactions. Add a reconciliation job that alerts on drift.
4. **Every write path takes an idempotency key.** SSLCommerz retries IPNs. A double-credited top-up is money you gave away.
5. **Lock before you read a balance you're about to change.** `SELECT … FOR UPDATE` inside a transaction. Two concurrent bookings must not both pass the same balance check.
6. **Never trust a gateway callback body.** Verify the signature _and_ independently re-query SSLCommerz's validation API before crediting anything.
7. **Balance can never go negative.** Enforce it in the database, not just the application.
8. **Held ≠ spent.** Track `balance` and `heldBalance` separately. Available = `balance - heldBalance`.

---

---

# 🛠️ PART 1: BACKEND IMPLEMENTATION

## Phase P1 (Backend) — Foundations

_No gateway yet. Get the money primitives right first._

### Step P1.1 — Prerequisite: close the payment hole

Do [FIXING.md Step F1.2](./FIXING.md) first if you have not. Do not build on top of an endpoint that lets a customer mark themselves paid.

---

### Step P1.2 — Migrate money to integer poisha

Every money column changes type. Do it now, while you have almost no data.

**`service.prisma`**

```prisma
model Service {
  // price Float   ← remove
  priceMinor Int   // poisha. ৳150.00 = 15000
  ...
}
```

**`payment.prisma`**

```prisma
model Payment {
  // amount Float  ← remove
  amountMinor Int
  ...
}
```

Migration with backfill — write it by hand so no data is lost:

```sql
-- prisma/migrations/xxxx_money_to_minor/migration.sql
ALTER TABLE services ADD COLUMN "priceMinor" INTEGER;
UPDATE services SET "priceMinor" = ROUND(price * 100)::INTEGER;
ALTER TABLE services ALTER COLUMN "priceMinor" SET NOT NULL;
ALTER TABLE services DROP COLUMN price;

ALTER TABLE payments ADD COLUMN "amountMinor" INTEGER;
UPDATE payments SET "amountMinor" = ROUND(amount * 100)::INTEGER;
ALTER TABLE payments ALTER COLUMN "amountMinor" SET NOT NULL;
ALTER TABLE payments DROP COLUMN amount;
```

Add one shared formatter and use it everywhere — never format inline:

```ts
// Salon-Management-Server/src/app/utils/money.ts
export const toMinor = (taka: number) => Math.round(taka * 100);
export const toTaka = (minor: number) => minor / 100;
export const formatBDT = (minor: number) =>
  `৳${(minor / 100).toLocaleString("en-BD", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
```

### Step P1.3 — Wallet schema

New file `prisma/schema/wallet.prisma`:

```prisma
model Wallet {
  id          String   @id @default(uuid())
  userId      String   @unique
  balance     Int      @default(0)   // poisha, total
  heldBalance Int      @default(0)   // poisha, reserved by active deposits
  currency    String   @default("BDT")
  isFrozen    Boolean  @default(false)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  user         User                @relation(fields: [userId], references: [id], onDelete: Cascade)
  transactions WalletTransaction[]

  @@map("wallets")
}

model WalletTransaction {
  id             String        @id @default(uuid())
  walletId       String
  type           WalletTxType
  amount         Int           // SIGNED poisha. credits +, debits −
  balanceAfter   Int           // running balance, for audit
  heldAfter      Int
  description    String
  referenceType  String?       // "APPOINTMENT" | "TOPUP" | "PAYOUT" | "QUEUE_ENTRY"
  referenceId    String?
  idempotencyKey String?       @unique
  metadata       Json?
  createdAt      DateTime      @default(now())

  wallet Wallet @relation(fields: [walletId], references: [id], onDelete: Cascade)

  @@index([walletId, createdAt])
  @@index([referenceType, referenceId])
  @@map("wallet_transactions")
}
```

Add to `enum.prisma`:

```prisma
enum WalletTxType {
  TOPUP             // + gateway top-up
  TOPUP_REVERSAL    // − failed/charged-back top-up
  DEPOSIT_HOLD      // 0 net; moves balance → heldBalance
  DEPOSIT_RELEASE   // 0 net; moves heldBalance → balance (cancelled in time)
  DEPOSIT_APPLIED   // − deposit consumed against a completed booking
  DEPOSIT_FORFEIT   // − deposit lost to a no-show
  REFUND            // + platform/salon-initiated refund
  CASHBACK          // + loyalty reward
  GOODWILL_CREDIT   // + compensation when a salon cancels
  ADJUSTMENT        // ± manual admin correction (always with a reason)
  WITHDRAWAL        // − cash-out, if you ever allow it
}
```

Then the database-level guard that application code cannot bypass:

```sql
ALTER TABLE wallets ADD CONSTRAINT wallet_balance_non_negative CHECK (balance >= 0);
ALTER TABLE wallets ADD CONSTRAINT wallet_held_non_negative    CHECK ("heldBalance" >= 0);
ALTER TABLE wallets ADD CONSTRAINT wallet_held_lte_balance     CHECK ("heldBalance" <= balance);
```

**Verify:** `npx prisma migrate dev --name add_wallet` succeeds; a manual `UPDATE wallets SET balance = -1` is rejected by Postgres.
**Commit:** `feat(wallet): add wallet and ledger schema`

---

### Step P1.4 — WalletService: the one function everything else calls

This is the most important function in the payment system. Every money movement goes through it. Nothing writes to `wallets` or `wallet_transactions` directly.

`src/app/modules/Wallet/wallet.service.ts`:

```ts
type MutateArgs = {
  userId: string;
  type: WalletTxType;
  amount: number; // SIGNED poisha
  holdDelta?: number; // SIGNED poisha change to heldBalance
  description: string;
  referenceType?: string;
  referenceId?: string;
  idempotencyKey?: string;
  metadata?: any;
};

const mutate = async (args: MutateArgs, tx?: Prisma.TransactionClient) => {
  const run = async (db: Prisma.TransactionClient) => {
    // 1. Idempotency — if we've already applied this key, return the original row.
    if (args.idempotencyKey) {
      const existing = await db.walletTransaction.findUnique({
        where: { idempotencyKey: args.idempotencyKey },
      });
      if (existing) return existing; // safe replay, no double-apply
    }

    // 2. Lock the wallet row. Everything after this is serialised per user.
    const [wallet] = await db.$queryRaw<Wallet[]>`
      SELECT * FROM wallets WHERE "userId" = ${args.userId} FOR UPDATE
    `;
    if (!wallet) throw new ApiError(404, "Wallet not found");
    if (wallet.isFrozen) throw new ApiError(403, "Wallet is frozen");

    // 3. Compute and check.
    const newBalance = wallet.balance + args.amount;
    const newHeld = wallet.heldBalance + (args.holdDelta ?? 0);

    if (newBalance < 0) throw new ApiError(400, "Insufficient wallet balance");
    if (newHeld < 0) throw new ApiError(400, "Invalid hold release");
    if (newHeld > newBalance)
      throw new ApiError(400, "Insufficient available balance");

    // 4. Write both sides together.
    await db.wallet.update({
      where: { id: wallet.id },
      data: { balance: newBalance, heldBalance: newHeld },
    });

    return db.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: args.type,
        amount: args.amount,
        balanceAfter: newBalance,
        heldAfter: newHeld,
        description: args.description,
        referenceType: args.referenceType,
        referenceId: args.referenceId,
        idempotencyKey: args.idempotencyKey,
        metadata: args.metadata,
      },
    });
  };

  // Join the caller's transaction if there is one — a booking must hold the
  // deposit and create the appointment atomically.
  return tx
    ? run(tx)
    : prisma.$transaction(run, { isolationLevel: "Serializable" });
};
```

Thin wrappers on top:

```ts
const getAvailableBalance = (w: Wallet) => w.balance - w.heldBalance;

const holdDeposit = (userId, amountMinor, appointmentId) =>
  mutate({
    userId,
    type: "DEPOSIT_HOLD",
    amount: 0,
    holdDelta: amountMinor,
    description: `Booking deposit held`,
    referenceType: "APPOINTMENT",
    referenceId: appointmentId,
    idempotencyKey: `hold:${appointmentId}`,
  });

const releaseDeposit = (userId, amountMinor, appointmentId) =>
  mutate({
    userId,
    type: "DEPOSIT_RELEASE",
    amount: 0,
    holdDelta: -amountMinor,
    description: `Deposit released — booking cancelled in time`,
    referenceType: "APPOINTMENT",
    referenceId: appointmentId,
    idempotencyKey: `release:${appointmentId}`,
  });

const applyDeposit = (userId, amountMinor, appointmentId) =>
  mutate({
    userId,
    type: "DEPOSIT_APPLIED",
    amount: -amountMinor,
    holdDelta: -amountMinor,
    description: `Deposit applied to your bill`,
    referenceType: "APPOINTMENT",
    referenceId: appointmentId,
    idempotencyKey: `apply:${appointmentId}`,
  });

const forfeitDeposit = (userId, amountMinor, appointmentId) =>
  mutate({
    userId,
    type: "DEPOSIT_FORFEIT",
    amount: -amountMinor,
    holdDelta: -amountMinor,
    description: `Deposit forfeited — marked as no-show`,
    referenceType: "APPOINTMENT",
    referenceId: appointmentId,
    idempotencyKey: `forfeit:${appointmentId}`,
  });
```

Note the idempotency keys are **derived from the appointment id**, so the same operation can never apply twice even if a retry, a double-click or a crashed request replays it.

Create the wallet lazily on first access (`getOrCreateWallet(userId)`), so existing users do not need a backfill.

**Verify:** unit test — wallet at 10000, fire two concurrent `holdDeposit(3000)` and one `holdDeposit(8000)`; the two 3000s succeed, the 8000 fails, `heldBalance` ends at exactly 6000.
**Commit:** `feat(wallet): core ledger service with locking and idempotency`

---

### Step P1.5 — Wallet API

`src/app/modules/Wallet/wallet.routes.ts`:

| Method | Path                                      | Auth       | Purpose                                  |
| ------ | ----------------------------------------- | ---------- | ---------------------------------------- |
| `GET`  | `/wallet/me`                              | any authed | balance, heldBalance, available          |
| `GET`  | `/wallet/me/transactions?page&limit&type` | any authed | paginated ledger                         |
| `POST` | `/wallet/admin/adjust`                    | `ADMIN`    | manual credit/debit, **reason required** |

`/wallet/admin/adjust` is how you test the entire deposit flow before the gateway exists. It must log to an audit trail and require a non-empty reason.

**Verify:** admin credits ৳500 to a test user; `GET /wallet/me` shows `balance: 50000, available: 50000`.
**Commit:** `feat(wallet): wallet API endpoints`

---

## Phase P2 (Backend) — SSLCommerz top-up

_Now money enters the system from outside._

### Step P2.1 — Merchant account and config

Register at [sslcommerz.com](https://sslcommerz.com) for a **sandbox** store first. You get a `store_id` and `store_passwd`.

```
# .env  (real values NEVER in .env.example)
SSLCZ_STORE_ID=yourstore_test
SSLCZ_STORE_PASSWD=xxxxx
SSLCZ_IS_LIVE=false
SSLCZ_SUCCESS_URL=https://api.yourdomain.com/api/v1/payments/sslcz/success
SSLCZ_FAIL_URL=https://api.yourdomain.com/api/v1/payments/sslcz/fail
SSLCZ_CANCEL_URL=https://api.yourdomain.com/api/v1/payments/sslcz/cancel
SSLCZ_IPN_URL=https://api.yourdomain.com/api/v1/payments/sslcz/ipn
```

Register the IPN URL in the SSLCommerz merchant panel — it is not picked up from the API call alone.

Add to `src/config/index.ts` alongside the existing `jwt` and `cloudinary` blocks.

> **Local development:** SSLCommerz cannot reach `localhost`. Use `ngrok http 5000` and put the public URL in the IPN/success URLs while testing.

---

### Step P2.2 — Provider interface

Keep gateways swappable so adding bKash direct later is not a rewrite.

`src/app/modules/Payment/providers/types.ts`:

```ts
export interface PaymentProvider {
  readonly name: string;
  initSession(args: {
    transactionId: string;
    amountMinor: number;
    customer: { name: string; email: string; phone: string };
    purpose: "WALLET_TOPUP" | "BOOKING";
  }): Promise<{ redirectUrl: string; sessionKey: string }>;

  /** Independently re-query the gateway. NEVER trust the callback body. */
  validate(valId: string): Promise<{
    valid: boolean;
    transactionId: string;
    amountMinor: number;
    gatewayRef: string;
    method: string | null;
    raw: unknown;
  }>;

  verifySignature(payload: Record<string, string>): boolean;
  refund(
    gatewayRef: string,
    amountMinor: number,
    reason: string,
  ): Promise<{ ok: boolean; refundRef?: string }>;
}
```

---

### Step P2.3 — SslCommerzProvider

`src/app/modules/Payment/providers/sslcommerz.provider.ts`.

> ⚠️ **Confirm every field name and endpoint against the SSLCommerz developer docs in your merchant panel before going live.** The shape below is the v4 API as commonly integrated; treat it as a starting point, not gospel.

```ts
const BASE = config.sslcz.isLive
  ? "https://securepay.sslcommerz.com"
  : "https://sandbox.sslcommerz.com";

async initSession({ transactionId, amountMinor, customer, purpose }) {
  const body = new URLSearchParams({
    store_id: config.sslcz.storeId,
    store_passwd: config.sslcz.storePasswd,
    total_amount: (amountMinor / 100).toFixed(2),   // gateway wants taka
    currency: "BDT",
    tran_id: transactionId,
    success_url: config.sslcz.successUrl,
    fail_url: config.sslcz.failUrl,
    cancel_url: config.sslcz.cancelUrl,
    ipn_url: config.sslcz.ipnUrl,
    cus_name: customer.name,
    cus_email: customer.email,
    cus_phone: customer.phone,
    cus_add1: "N/A",
    cus_city: "Dhaka",
    cus_country: "Bangladesh",
    shipping_method: "NO",
    product_name: purpose === "WALLET_TOPUP" ? "Wallet Top-up" : "Salon Booking",
    product_category: "Service",
    product_profile: "general",
  });

  const res = await fetch(`${BASE}/gwprocess/v4/api.php`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (json.status !== "SUCCESS") {
    throw new ApiError(502, json.failedreason || "Could not start payment session");
  }
  return { redirectUrl: json.GatewayPageURL, sessionKey: json.sessionkey };
}

async validate(valId: string) {
  const url = new URL(`${BASE}/validator/api/validationserverAPI.php`);
  url.searchParams.set("val_id", valId);
  url.searchParams.set("store_id", config.sslcz.storeId);
  url.searchParams.set("store_passwd", config.sslcz.storePasswd);
  url.searchParams.set("format", "json");

  const json = await (await fetch(url)).json();
  return {
    valid: json.status === "VALID" || json.status === "VALIDATED",
    transactionId: json.tran_id,
    amountMinor: Math.round(parseFloat(json.amount) * 100),
    gatewayRef: json.bank_tran_id,
    method: json.card_type ?? null,
    raw: json,
  };
}
```

`verifySignature` follows the documented `verify_sign` / `verify_key` md5 scheme. **Even with a valid signature, always call `validate()` before crediting** — the signature proves the message came from SSLCommerz, the validation call proves the money actually settled.

---

### Step P2.4 — PaymentIntent schema

A top-up needs a record that exists _before_ the customer leaves for the gateway.

```prisma
model PaymentIntent {
  id             String        @id @default(uuid())
  transactionId  String        @unique      // our id, sent as tran_id
  userId         String
  purpose        IntentPurpose               // WALLET_TOPUP | BOOKING
  amountMinor    Int
  status         IntentStatus  @default(INITIATED)
  provider       String        @default("SSLCOMMERZ")
  gatewayRef     String?
  method         String?
  sessionKey     String?
  rawResponse    Json?
  referenceId    String?       // appointmentId when purpose = BOOKING
  failureReason  String?
  completedAt    DateTime?
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, createdAt])
  @@index([status, createdAt])
  @@map("payment_intents")
}

enum IntentPurpose { WALLET_TOPUP  BOOKING }
enum IntentStatus  { INITIATED  PENDING  SUCCESS  FAILED  CANCELLED  EXPIRED }
```

---

### Step P2.5 — Top-up initiation

`POST /wallet/topup` (auth: any signed-in user)

```ts
const initiateTopup = async (userId: string, amountMinor: number) => {
  if (amountMinor < 10000) throw new ApiError(400, "Minimum top-up is ৳100");
  if (amountMinor > 5000000)
    throw new ApiError(400, "Maximum top-up is ৳50,000");

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  const intent = await prisma.paymentIntent.create({
    data: {
      transactionId: `TOPUP-${Date.now()}-${randomBytes(4).toString("hex")}`,
      userId,
      purpose: "WALLET_TOPUP",
      amountMinor,
      status: "INITIATED",
    },
  });

  const session = await provider.initSession({
    transactionId: intent.transactionId,
    amountMinor,
    customer: {
      name: user.name,
      email: user.email,
      phone: user.phone ?? "01700000000",
    },
    purpose: "WALLET_TOPUP",
  });

  await prisma.paymentIntent.update({
    where: { id: intent.id },
    data: { status: "PENDING", sessionKey: session.sessionKey },
  });

  return {
    redirectUrl: session.redirectUrl,
    transactionId: intent.transactionId,
  };
};
```

### Step P2.6 — The IPN webhook (the part that must be bulletproof)

`POST /payments/sslcz/ipn` — **no `auth()` middleware** (SSLCommerz has no JWT), and it must accept `application/x-www-form-urlencoded`.

```ts
const handleIpn = catchAsync(async (req, res) => {
  // Always 200 quickly — a non-200 makes SSLCommerz retry forever.
  res.status(200).json({ received: true });

  const payload = req.body;

  // 1. Signature check — proves it came from SSLCommerz
  if (!provider.verifySignature(payload)) {
    logger.warn(
      { tran_id: payload.tran_id },
      "IPN signature verification failed",
    );
    return;
  }

  // 2. Independent re-query — proves the money actually settled
  const result = await provider.validate(payload.val_id);
  if (!result.valid) {
    await markIntentFailed(payload.tran_id, `Gateway status ${payload.status}`);
    return;
  }

  const intent = await prisma.paymentIntent.findUnique({
    where: { transactionId: result.transactionId },
  });
  if (!intent) {
    logger.error({ tran_id: result.transactionId }, "IPN for unknown intent");
    return;
  }

  // 3. Replay guard — this IPN may already have been processed
  if (intent.status === "SUCCESS") return;

  // 4. Amount tamper check — the gateway amount MUST match what we asked for
  if (result.amountMinor !== intent.amountMinor) {
    logger.error(
      {
        intentId: intent.id,
        expected: intent.amountMinor,
        got: result.amountMinor,
      },
      "IPN amount mismatch — possible tampering",
    );
    await markIntentFailed(intent.transactionId, "Amount mismatch");
    return;
  }

  // 5. Credit — atomically with marking the intent complete
  await prisma.$transaction(async (tx) => {
    await tx.paymentIntent.update({
      where: { id: intent.id },
      data: {
        status: "SUCCESS",
        gatewayRef: result.gatewayRef,
        method: result.method,
        rawResponse: result.raw as any,
        completedAt: new Date(),
      },
    });

    if (intent.purpose === "WALLET_TOPUP") {
      await WalletService.mutate(
        {
          userId: intent.userId,
          type: "TOPUP",
          amount: intent.amountMinor,
          description: `Top-up via ${result.method ?? "SSLCommerz"}`,
          referenceType: "TOPUP",
          referenceId: intent.id,
          idempotencyKey: `topup:${intent.transactionId}`, // ← the replay guard
        },
        tx,
      );
    }
  });

  await NotificationService.send(intent.userId, "TOPUP_SUCCESS", {
    amount: formatBDT(intent.amountMinor),
  });
});
```

**Five defences, in order:** signature → independent validation → replay guard → amount check → idempotency key. Each one alone is insufficient.

**Success/fail/cancel return routes** only redirect the browser back to the frontend. They must **never** credit anything — a user can hand-craft a request to the success URL. Only the IPN moves money.

```ts
router.post("/sslcz/success", (req, res) =>
  res.redirect(
    `${FRONTEND}/dashboard/wallet?topup=processing&tran=${req.body.tran_id}`,
  ),
);
router.post("/sslcz/fail", (req, res) =>
  res.redirect(`${FRONTEND}/dashboard/wallet?topup=failed`),
);
router.post("/sslcz/cancel", (req, res) =>
  res.redirect(`${FRONTEND}/dashboard/wallet?topup=cancelled`),
);
```

### Step P2.7 — Reconciliation job

Intents that never get an IPN (browser closed mid-payment, gateway hiccup) must not stay `PENDING` forever.

Hourly: for every intent `PENDING` and older than 30 minutes, call `provider.validate()` by transaction id. Settle it either way. Alert if any intent has been pending more than 24 hours.

**Verify the whole phase:**

```
1. Top up ৳500 in sandbox → wallet shows ৳500, one TOPUP row
2. Replay the same IPN body 5× → still ৳500, still one row
3. Tamper the IPN amount → rejected, logged, not credited
4. POST directly to /sslcz/success with a fake tran_id → nothing credited
5. Cancel at the gateway → intent CANCELLED, wallet unchanged
```

**Commit:** `feat(payment): SSLCommerz wallet top-up with IPN verification`

---

## Phase P3 (Backend) — Deposits on booking

### Step P3.1 — Deposit policy per salon

```prisma
model Salon {
  ...
  depositMinor          Int     @default(3000)   // ৳30
  depositPercent        Int?                     // optional: % of total instead
  cancellationWindowMin Int     @default(120)    // free cancel up to 2h before
  noShowSalonSharePct   Int     @default(70)     // salon's cut of a forfeit
}
```

Resolution: `depositPercent` if set, else `depositMinor`; clamp to a platform min (৳20) and max (৳500). For high-ticket services (bridal, keratin) a percentage makes more sense than a flat fee.

### Step P3.2 — Hold the deposit at booking time

In `appointment.service.ts`, inside the **existing** `prisma.$transaction` that already claims the slot (`appointment.service.ts:79-100`) — the hold and the appointment must be atomic:

```ts
const appointment = await prisma.$transaction(async (tx) => {
  const claimed = await tx.slot.updateMany({
    where: { id: payload.slotId, status: "AVAILABLE", isBooked: false },
    data: { status: "BOOKED", isBooked: true },
  });
  if (claimed.count === 0) throw new ApiError(409, "Slot just taken");

  const depositMinor = resolveDeposit(salon, service);

  const created = await tx.appointment.create({
    data: { ...,
      totalMinor: service.priceMinor,
      depositMinor,
    },
  });

  if (depositMinor > 0) {
    await WalletService.holdDeposit(userId, depositMinor, created.id);  // same tx
  }
  return created;
});
```

If the wallet has insufficient available balance the whole transaction rolls back — slot released, no appointment. Return a `402` the frontend turns into _"Add ৳30 to your wallet to confirm this booking"_ with a top-up button.

---

### Step P3.3 — Resolve the deposit on outcome

Wire into `updateAppointmentStatus` and `cancelAppointment`:

| Transition                                              | Action                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| → `CANCELLED` by customer, **before** the window closes | `releaseDeposit` — full amount back to available               |
| → `CANCELLED` by customer, **inside** the window        | `forfeitDeposit` — split per `noShowSalonSharePct`             |
| → `CANCELLED` by salon or admin                         | `releaseDeposit` + optional `GOODWILL_CREDIT`                  |
| → `COMPLETED`                                           | `applyDeposit` — deposit comes off the bill                    |
| → `NO_SHOW`                                             | `forfeitDeposit` + `LedgerEntry` crediting the salon its share |

Guard rails:

- Only the salon or an admin may set `NO_SHOW`, and only after `startsAt` has passed.
- A no-show is **appealable for 48 hours** — the customer can dispute, an admin can reverse with an `ADJUSTMENT`. Publish this; it is what stops the mechanic feeling unfair.
- Auto-`NO_SHOW` after a grace period (default 20 min) via a scheduled job, so owners don't have to remember.

Every one of these is idempotent by appointment id, so a double-click or a retry cannot double-charge.

---

## Phase P4 (Backend) — Salon settlement

### Step P4.1 — Commission rules

```prisma
model CommissionRule {
  id             String   @id @default(uuid())
  salonId        String?              // null = platform default
  minAmountMinor Int      @default(0)
  maxAmountMinor Int?
  flatFeeMinor   Int?                 // e.g. 1000 = ৳10
  percentBps     Int?                 // basis points. 800 = 8%
  appliesTo      CommissionScope      // NEW_CUSTOMER | OFF_PEAK | ALL
  isActive       Boolean  @default(true)
}
```

Platform defaults:

| Booking                     | Commission                         |
| --------------------------- | ---------------------------------- |
| Salon's own repeat customer | **0**                              |
| New customer under ৳500     | flat ৳10                           |
| New customer ৳500+          | 8%                                 |
| Off-peak fill               | flat ৳10 or 5%, whichever is lower |

> **The 0% on repeat customers rule is the reason salons will sign.** It changes your pitch from _"give me a cut of your business"_ to _"pay me only for money I brought you."_ Requires `Appointment.source` and a first-booking check against that salon — implement both here.

---

### Step P4.2 — Ledger entries

Every completed booking writes a balanced set of rows:

```prisma
model LedgerEntry {
  id            String      @id @default(uuid())
  appointmentId String?
  salonId       String?
  account       LedgerAccount   // SALON_PAYABLE | PLATFORM_REVENUE | CUSTOMER_WALLET | GATEWAY_CLEARING
  amountMinor   Int             // signed
  description   String
  payoutId      String?
  createdAt     DateTime    @default(now())

  @@index([salonId, createdAt])
  @@index([payoutId])
}
```

Example — a ৳105 off-peak cut, ৳30 deposit, ৳10 commission:

| Account            | Amount  | Note                  |
| ------------------ | ------- | --------------------- |
| `SALON_PAYABLE`    | `+3000` | deposit owed to salon |
| `PLATFORM_REVENUE` | `+1000` | commission            |
| `SALON_PAYABLE`    | `−1000` | commission deducted   |

Salon nets ৳20 from the platform; collects ৳75 cash at the counter. **Every appointment's entries must sum to zero across accounts** — that is your reconciliation test.

---

### Step P4.3 — Payouts

```prisma
model Payout {
  id            String       @id @default(uuid())
  salonId       String
  periodStart   DateTime
  periodEnd     DateTime
  grossMinor    Int
  commissionMinor Int
  netMinor      Int
  status        PayoutStatus  // PENDING | PROCESSING | PAID | FAILED
  method        String?       // BKASH | BANK
  reference     String?
  paidAt        DateTime?
}
```

- Weekly batch (configurable) rolls up unpaid `SALON_PAYABLE` entries per salon.

# Phase P5 — Money notifications

Wire `NotificationService` (see [FEATURE.md](./FEATURE.md)) to these events. **SMS is not optional in Bangladesh** — most customers never open email.

| Event              | Channel     | Message                                                           |
| ------------------ | ----------- | ----------------------------------------------------------------- |
| Top-up success     | SMS + push  | `৳500 added. Balance ৳500.`                                       |
| Booking confirmed  | SMS         | `Booked: Glamour, Tue 12:30. ৳30 deposit held, ৳75 due at salon.` |
| T−2h reminder      | SMS + push  | `Your appointment is in 2 hours. Cancel free before 10:30.`       |
| Cancelled in time  | push        | `৳30 returned to your wallet.`                                    |
| Marked no-show     | SMS         | `৳30 deposit forfeited. Think this is wrong? Appeal within 48h.`  |
| Completed          | push        | `Thanks! ৳15 cashback added. Rate your visit?`                    |
| Owner: new booking | SMS         | `New booking: Rahim, Haircut, Tue 12:30.`                         |
| Owner: payout sent | SMS + email | `৳2,450 sent to your bKash. Ref BK123.`                           |

Pick a bulk BD SMS provider that supports Bengali (UTF-16) — check per-SMS cost carefully, since Bengali characters halve the per-segment character count and can double your cost.

---

## Done checklist (Backend)

```
P1  Foundations
  □ P1.1  Payment security hole closed (FIXING.md F1.2)
  □ P1.2  Money migrated to integer poisha (Schema + Utils)
  □ P1.3  Wallet + WalletTransaction schema + CHECK constraints
  □ P1.4  WalletService.mutate — locking + idempotency
  □ P1.5  Wallet API

P2  SSLCommerz
  □ P2.1  Sandbox account + env config + IPN URL registered
  □ P2.2  PaymentProvider interface
  □ P2.3  SslCommerzProvider (init + validate + verifySignature)
  □ P2.4  PaymentIntent schema
  □ P2.5  Top-up initiation API
  □ P2.6  IPN webhook — 5 defences
  □ P2.7  Reconciliation job

P3  Deposits
  □ P3.1  Per-salon deposit policy schema
  □ P3.2  Hold inside the booking transaction
  □ P3.3  Release / apply / forfeit + 48h appeal

P4  Settlement
  □ P4.1  Commission rules (incl. 0% repeat customers)
  □ P4.2  LedgerEntry
  □ P4.3  Payout batch + admin queue

P5  □ Money notifications over SMS + push
```

---
