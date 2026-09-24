import { randomBytes } from "crypto";
import {
  IntentPurpose,
  IntentStatus,
  PaymentIntent,
  Prisma,
  WalletTxType,
} from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { formatBDT } from "../../utils/money";
import { sendEmail } from "../../utils/emailSender";
import { getWalletTopupInvoiceTemplate } from "../../utils/emailTemplates";
import { WalletService } from "../Wallet/wallet.service";
import { getProvider, listProviders } from "./providers";
import {
  bkashProvider,
  verifyBkashSettlement,
} from "./providers/bkash/bkash.provider";
import { redactBkash } from "./providers/bkash/bkash.client";
import {
  bkashFailureReason,
  classifyBkashError,
} from "./providers/bkash/bkash.errors";
import { sslCommerzProvider } from "./providers/sslcommerz.provider";
import { ProviderName } from "./providers/types";

const MIN_TOPUP_MINOR = 10000; // BDT 100
const MAX_TOPUP_MINOR = 5000000; // BDT 50,000

/** Intents older than this with no IPN get chased by the reconciliation job. */
const STALE_AFTER_MS = 30 * 60 * 1000;
/** Past this, a stuck intent is not a hiccup any more - it needs a human. */
const ALERT_AFTER_MS = 24 * 60 * 60 * 1000;

const newTransactionId = (prefix: string) =>
  `${prefix}-${Date.now()}-${randomBytes(4).toString("hex")}`;

// ---------------------------------------------------------------------------
// Initiation
// ---------------------------------------------------------------------------

const initiateTopup = async (
  userId: string,
  amountMinor: number,
  providerName: ProviderName = "SSLCOMMERZ",
) => {
  // Before the amount checks: an unavailable method is the answer whatever the
  // amount, and the customer should hear that first.
  const provider = getProvider(providerName);

  if (!provider.isEnabled()) {
    throw new ApiError(
      StatusCodes.SERVICE_UNAVAILABLE,
      `${provider.displayName} is not available right now`,
    );
  }

  if (amountMinor < MIN_TOPUP_MINOR) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `Minimum top-up is ${formatBDT(MIN_TOPUP_MINOR)}`,
    );
  }

  if (amountMinor > MAX_TOPUP_MINOR) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `Maximum top-up is ${formatBDT(MAX_TOPUP_MINOR)}`,
    );
  }

  const user = await prisma.user.findFirst({
    where: { id: userId, isDeleted: false },
  });

  if (!user) {
    throw new ApiError(StatusCodes.NOT_FOUND, "User not found");
  }

  // Make sure the wallet exists before money is on its way to it.
  await WalletService.getOrCreateWallet(userId);

  const intent = await prisma.paymentIntent.create({
    data: {
      transactionId: newTransactionId("TOPUP"),
      userId,
      purpose: IntentPurpose.WALLET_TOPUP,
      amountMinor,
      status: IntentStatus.INITIATED,
      provider: provider.name,
    },
  });

  try {
    const session = await provider.createSession({
      transactionId: intent.transactionId,
      amountMinor,
      customer: {
        name: user.name,
        email: user.email,
        phone: user.phone ?? null,
      },
      purpose: "WALLET_TOPUP",
    });

    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { status: IntentStatus.PENDING, sessionKey: session.sessionKey },
    });

    return {
      redirectUrl: session.redirectUrl,
      transactionId: intent.transactionId,
      amountMinor,
    };
  } catch (error) {
    // Do not leave an INITIATED row behind that the reconciliation job will
    // keep chasing - the customer never reached the gateway at all.
    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: {
        status: IntentStatus.FAILED,
        failureReason:
          error instanceof Error ? error.message : "Could not start session",
      },
    });
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

type TerminalStatus =
  | typeof IntentStatus.FAILED
  | typeof IntentStatus.CANCELLED
  | typeof IntentStatus.EXPIRED;

const markIntentFailed = async (
  transactionId: string,
  reason: string,
  status: TerminalStatus = IntentStatus.FAILED,
) => {
  await prisma.paymentIntent.updateMany({
    // Never walk back a success: an intent that already credited stays credited.
    where: {
      transactionId,
      status: { in: [IntentStatus.INITIATED, IntentStatus.PENDING] },
    },
    data: { status, failureReason: reason },
  });
};

/**
 * Marks the intent complete and credits the wallet in one transaction, so the
 * ledger can never disagree with the intent about whether money arrived.
 */
const creditSettledIntent = async (
  intent: PaymentIntent,
  settled: {
    gatewayRef: string | null;
    method: string | null;
    raw: unknown;
  },
) => {
  const provider = getProvider(intent.provider);

  const credited = await prisma.$transaction(async (tx) => {
    // Claim the intent before doing anything else. The IPN and the customer's
    // own return can land at the same moment; the second one blocks on this row
    // and then finds it already SUCCESS. The wallet credit is idempotent on its
    // own, but the receipt email is not, so the loser has to stop here.
    const claim = await tx.paymentIntent.updateMany({
      where: { id: intent.id, status: { not: IntentStatus.SUCCESS } },
      data: {
        status: IntentStatus.SUCCESS,
        gatewayRef: settled.gatewayRef,
        method: settled.method,
        rawResponse: settled.raw as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });

    if (claim.count === 0) return false;

    if (intent.purpose === IntentPurpose.WALLET_TOPUP) {
      await WalletService.mutate(
        {
          userId: intent.userId,
          type: WalletTxType.TOPUP,
          amount: intent.amountMinor,
          description: `Top-up via ${settled.method ?? provider.displayName}`,
          referenceType: "TOPUP",
          referenceId: intent.id,
          // The wallet history renders these. Without them a ledger row has no
          // way back to the gateway payment that produced it, and the customer
          // has no id to quote to support.
          metadata: {
            transactionId: intent.transactionId,
            gatewayRef: settled.gatewayRef ?? null,
            method: settled.method ?? null,
            provider: intent.provider,
            gatewayEnv: provider.isTestMode() ? "sandbox" : "live",
          },
          // The final replay guard: even if every check above is passed twice,
          // this key means the money only lands once.
          idempotencyKey: `topup:${intent.transactionId}`,
        },
        tx,
      );
    }

    return true;
    // The same budget as WalletService: at Prisma's 5s default a slow hosted
    // Postgres closed this mid-credit after bKash had already captured the money.
  }, { maxWait: 10_000, timeout: 15_000 });

  if (credited) notifyTopupSuccess(intent, settled);
};

const notifyTopupSuccess = (
  intent: PaymentIntent,
  settled: { gatewayRef: string | null; method: string | null },
) => {
  if (intent.purpose !== IntentPurpose.WALLET_TOPUP) return;

  const providerName = getProvider(intent.provider).displayName;

  void (async () => {
    try {
      const [user, wallet] = await Promise.all([
        prisma.user.findUnique({
          where: { id: intent.userId },
          select: { name: true, email: true },
        }),
        prisma.wallet.findUnique({ where: { userId: intent.userId } }),
      ]);

      if (!user?.email || !wallet) return;

      await sendEmail(
        user.email,
        `Payment receipt - ${formatBDT(intent.amountMinor)} added to your wallet`,
        getWalletTopupInvoiceTemplate({
          customerName: user.name || "there",
          transactionId: intent.transactionId,
          amount: formatBDT(intent.amountMinor),
          availableBalance: formatBDT(wallet.balance - wallet.heldBalance),
          method: settled.method ?? providerName,
          gatewayRef: settled.gatewayRef ?? null,
          paidAt: new Date(),
          provider: providerName,
        }),
      );
    } catch (error) {
      console.error("[payment.notify] top-up email failed", error);
    }
  })();
};

/**
 * The webhook that actually moves money. Five defences, in order, each one
 * insufficient on its own:
 *
 *   1. signature              - the message came from SSLCommerz
 *   2. independent validation - the money really settled
 *   3. replay guard           - this IPN has not already been processed
 *   4. amount check           - the settled amount is the amount we asked for
 *   5. idempotency key        - the credit itself cannot apply twice
 */
const processIpn = async (payload: Record<string, string>) => {
  if (!sslCommerzProvider.verifySignature(payload)) {
    console.warn(
      `[payment.ipn] signature verification failed for tran_id=${payload?.tran_id}`,
    );
    return;
  }

  if (!payload.val_id) {
    console.warn(`[payment.ipn] no val_id for tran_id=${payload?.tran_id}`);
    return;
  }

  const result = await sslCommerzProvider.validate(payload.val_id);

  if (!result.valid) {
    await markIntentFailed(
      payload.tran_id,
      `Gateway status ${payload.status ?? "unknown"}`,
    );
    return;
  }

  const intent = await prisma.paymentIntent.findUnique({
    where: { transactionId: result.transactionId },
  });

  if (!intent) {
    console.error(
      `[payment.ipn] IPN for unknown intent tran_id=${result.transactionId}`,
    );
    return;
  }

  if (intent.status === IntentStatus.SUCCESS) return;

  if (result.amountMinor !== intent.amountMinor) {
    console.error(
      `[payment.ipn] amount mismatch on intent=${intent.id}: expected ${intent.amountMinor}, got ${result.amountMinor} - possible tampering`,
    );
    await markIntentFailed(intent.transactionId, "Amount mismatch");
    return;
  }

  await creditSettledIntent(intent, {
    gatewayRef: result.gatewayRef,
    method: result.method,
    raw: result.raw,
  });
};

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Settle one intent against the gateway's own record of it.
 *
 * This is the path for every case where the IPN is not what tells us how a
 * payment ended: the reconciliation sweep, and the fail/cancel redirect - whose
 * POST body anyone could hand-craft, so it is never trusted to close an intent
 * by itself. Returns the status the intent now has.
 */
const settleFromGateway = async (intent: PaymentIntent) => {
  // Always the gateway that created the intent, whatever the default is today.
  const result = await getProvider(intent.provider).lookup(intent);

  if (result.state === "SETTLED") {
    const invoiceOk = !result.invoice || result.invoice === intent.transactionId;

    if (invoiceOk && result.amountMinor === intent.amountMinor) {
      await creditSettledIntent(intent, {
        gatewayRef: result.gatewayRef,
        method: result.method,
        raw: result.raw,
      });
      return IntentStatus.SUCCESS;
    }

    const why = invoiceOk ? "Amount mismatch" : "Invoice mismatch";
    console.error(
      `[payment.settle] ${why} on intent=${intent.id}: expected ${intent.amountMinor}, got ${result.amountMinor}`,
    );
    await markIntentFailed(intent.transactionId, why);
    return IntentStatus.FAILED;
  }

  // Still genuinely in flight at the gateway - leave it alone.
  if (result.state === "PENDING") return intent.status;

  const status: TerminalStatus =
    result.state === "CANCELLED"
      ? IntentStatus.CANCELLED
      : result.state === "EXPIRED"
        ? IntentStatus.EXPIRED
        : IntentStatus.FAILED;

  await markIntentFailed(
    intent.transactionId,
    result.reason ??
      (status === IntentStatus.CANCELLED
        ? "Payment cancelled at the gateway"
        : "Payment did not complete"),
    status,
  );
  return status;
};

/**
 * Close out a single intent by transaction id, for the fail and cancel returns.
 *
 * A gateway lookup that throws leaves the intent PENDING on purpose: the
 * reconciliation sweep will get to it, which is much better than trusting an
 * unauthenticated redirect body and writing off a payment that did settle.
 */
const resolveByTransactionId = async (transactionId: string) => {
  const intent = await prisma.paymentIntent.findUnique({
    where: { transactionId },
  });

  if (!intent) {
    console.warn(`[payment.resolve] unknown transaction ${transactionId}`);
    return;
  }

  if (
    intent.status !== IntentStatus.INITIATED &&
    intent.status !== IntentStatus.PENDING
  ) {
    return;
  }

  await settleFromGateway(intent);
};

type CallbackOutcome = {
  outcome: "success" | "failed" | "cancelled";
  transactionId?: string;
};

const isOpen = (status: IntentStatus) =>
  status === IntentStatus.INITIATED || status === IntentStatus.PENDING;

/**
 * bKash sends the customer back with `paymentID` and `status`. Nothing in that
 * URL is trusted: a success is only a success once our own execute call (or a
 * query) says so, and a paymentID we did not issue never reaches bKash at all.
 *
 * Only SUCCESS is final. A success callback for an intent already marked
 * CANCELLED/FAILED/EXPIRED still executes: `creditSettledIntent` overrides
 * anything but SUCCESS, and `markIntentFailed` never touches SUCCESS.
 */
const settleBkashCallback = async (
  paymentID: string,
  status: string,
): Promise<CallbackOutcome> => {
  const intent = paymentID
    ? await prisma.paymentIntent.findUnique({
        where: {
          provider_sessionKey: { provider: "BKASH", sessionKey: paymentID },
        },
      })
    : null;

  if (!intent) {
    console.warn(
      `[payment.bkash] callback for an unknown paymentID ${JSON.stringify(paymentID.slice(0, 64))}`,
    );
    return { outcome: "failed" };
  }

  const tran = intent.transactionId;
  if (intent.status === IntentStatus.SUCCESS) {
    return { outcome: "success", transactionId: tran };
  }

  if (status === "success") {
    try {
      const r = await bkashProvider.execute(paymentID, tran);

      if (r.ok) {
        const check = verifyBkashSettlement(intent, r.data);
        if (check.ok) {
          await creditSettledIntent(intent, {
            gatewayRef: r.data.trxID ?? null,
            method: "bKash",
            raw: redactBkash(r.data),
          });
          return { outcome: "success", transactionId: tran };
        }

        console.error(
          `[payment.bkash] possible tampering on intent=${intent.id}: ${check.reason}`,
        );
        await markIntentFailed(tran, check.reason);
        return { outcome: "failed", transactionId: tran };
      }

      const { kind } = classifyBkashError(r.code);
      if (kind !== "ambiguous" && kind !== "unknown") {
        await markIntentFailed(tran, bkashFailureReason(r.code, r.message));
        return { outcome: "failed", transactionId: tran };
      }

      // The money may or may not have moved. Ask bKash; this credits on its own
      // if the payment did complete.
      const state = await settleFromGateway(intent);
      if (state === IntentStatus.SUCCESS) {
        return { outcome: "success", transactionId: tran };
      }
      if (!isOpen(state)) return { outcome: "failed", transactionId: tran };
      // Still in flight: the result page polls and reconciliation settles it.
      return { outcome: "success", transactionId: tran };
    } catch (err) {
      console.error(
        `[payment.bkash] callback settle failed for intent=${intent.id}:`,
        (err as Error).message,
      );
      return { outcome: "success", transactionId: tran };
    }
  }

  const cancelled = status === "cancel";
  try {
    const state = await settleFromGateway(intent);
    if (state === IntentStatus.SUCCESS) {
      return { outcome: "success", transactionId: tran };
    }
    if (isOpen(state)) {
      await markIntentFailed(
        tran,
        cancelled
          ? "You cancelled the bKash payment."
          : "The bKash payment did not complete.",
        cancelled ? IntentStatus.CANCELLED : IntentStatus.FAILED,
      );
    }
  } catch (err) {
    // bKash could not be asked: leave the intent PENDING for reconciliation
    // rather than write off a payment on the word of a redirect.
    console.error(
      `[payment.bkash] callback lookup failed for intent=${intent.id}:`,
      (err as Error).message,
    );
  }
  return { outcome: cancelled ? "cancelled" : "failed", transactionId: tran };
};

const METHOD_COPY: Record<ProviderName, { name: string; description: string }> = {
  BKASH: {
    name: "bKash",
    description: "Pay from your bKash account with OTP and PIN",
  },
  SSLCOMMERZ: {
    name: "Card, Nagad, Rocket & more",
    description: "Secure checkout by SSLCommerz",
  },
};

const listPaymentMethods = () =>
  listProviders().map((p) => ({
    id: p.name,
    name: METHOD_COPY[p.name].name,
    description: METHOD_COPY[p.name].description,
    enabled: p.isEnabled(),
    testMode: p.isTestMode(),
    minMinor: MIN_TOPUP_MINOR,
    maxMinor: MAX_TOPUP_MINOR,
  }));

/**
 * An intent whose IPN never arrived must not sit PENDING forever. Ask the
 * gateway what happened and settle it either way.
 */
const reconcilePendingIntents = async () => {
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS);

  const pending = await prisma.paymentIntent.findMany({
    where: {
      status: { in: [IntentStatus.INITIATED, IntentStatus.PENDING] },
      createdAt: { lt: staleBefore },
    },
    orderBy: { createdAt: "asc" },
    take: 100,
  });

  let credited = 0;
  let failed = 0;

  for (const intent of pending) {
    try {
      const status = await settleFromGateway(intent);

      if (status === IntentStatus.SUCCESS) {
        credited += 1;
      } else if (status === IntentStatus.INITIATED || status === IntentStatus.PENDING) {
        if (Date.now() - intent.createdAt.getTime() > ALERT_AFTER_MS) {
          console.error(
            `[payment.reconcile] intent=${intent.id} has been pending for over 24h - needs manual review`,
          );
        }
      } else {
        failed += 1;
      }
    } catch (error) {
      console.error(
        `[payment.reconcile] could not reconcile intent=${intent.id}`,
        error,
      );
    }
  }

  if (pending.length) {
    console.log(
      `[payment.reconcile] checked ${pending.length} stale intents: ${credited} credited, ${failed} failed`,
    );
  }

  return { checked: pending.length, credited, failed };
};

// ---------------------------------------------------------------------------
// Refunds (admin)
// ---------------------------------------------------------------------------

/** Both the reversal and its undo carry this, so their sum is what was refunded. */
const REFUND_REFERENCE = "TOPUP_REFUND";

type RefundStatus = "COMPLETED" | "UNKNOWN" | "FAILED";

/**
 * Appends to `rawResponse.refunds[]` in one statement, so two refunds that
 * finish together cannot overwrite each other's entry.
 */
const recordRefund = async (
  intentId: string,
  entry: { n: number; amountMinor: number; status: RefundStatus } & Record<string, unknown>,
) => {
  try {
    await prisma.$executeRaw`
      UPDATE payment_intents
      SET "rawResponse" = jsonb_set(
            CASE WHEN jsonb_typeof("rawResponse") = 'object' THEN "rawResponse" ELSE '{}'::jsonb END,
            '{refunds}',
            COALESCE("rawResponse"->'refunds', '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb
          ),
          "updatedAt" = NOW()
      WHERE id = ${intentId}
    `;
  } catch (error) {
    // The ledger row already says the money left; this only loses the
    // gateway's reference, so it must not turn a done refund into an error.
    console.error(
      `[payment.refund] intent=${intentId} could not store ${JSON.stringify(entry)}`,
      error,
    );
  }
};

/**
 * Sends part or all of a top-up back to where it came from.
 *
 * The wallet goes first: the money is debited, under a lock, before the
 * gateway is asked for anything. If the customer has already spent it the
 * debit is refused and the gateway is never called, so the same taka can never
 * be both refunded and still spendable. Only a definite "no" from the gateway
 * puts it back; a timeout leaves it out and asks for a manual check, because
 * undoing a refund that did go through would pay the customer twice.
 */
const refundTopup = async (
  adminId: string,
  intentId: string,
  amountMinor: number | undefined,
  reason: string,
) => {
  // The admin is more likely to have the transaction id (it is on the wallet
  // row) than our internal id.
  const intent = await prisma.paymentIntent.findFirst({
    where: { OR: [{ id: intentId }, { transactionId: intentId }] },
  });

  if (!intent) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Payment not found");
  }

  const provider = getProvider(intent.provider);
  const gatewayRef = intent.gatewayRef;

  if (
    intent.status !== IntentStatus.SUCCESS ||
    intent.purpose !== IntentPurpose.WALLET_TOPUP ||
    !gatewayRef ||
    !provider.refund
  ) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "Only a completed wallet top-up can be refunded",
    );
  }

  if (amountMinor !== undefined && (!Number.isInteger(amountMinor) || amountMinor <= 0)) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "Refund amount must be a positive whole number of poisha",
    );
  }

  // 1. Reserve: take the money out of the wallet. The advisory lock serialises
  //    refunds of this intent, so two admins cannot both refund what is left.
  const { amount, remainingMinor, n } = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`refund:${intent.id}`}::text, 0))`;

      // A refused refund's undo is +amount under the same reference, so it
      // nets out here and that amount can be refunded again.
      const net = await tx.walletTransaction.aggregate({
        where: { referenceType: REFUND_REFERENCE, referenceId: intent.id },
        _sum: { amount: true },
      });
      const attempts = await tx.walletTransaction.count({
        where: {
          referenceType: REFUND_REFERENCE,
          referenceId: intent.id,
          type: WalletTxType.TOPUP_REVERSAL,
        },
      });

      const remaining = intent.amountMinor + (net._sum.amount ?? 0);
      const amount = amountMinor ?? remaining;

      if (remaining <= 0) {
        throw new ApiError(
          StatusCodes.BAD_REQUEST,
          "This top-up has already been refunded in full",
        );
      }
      if (amount > remaining) {
        throw new ApiError(
          StatusCodes.BAD_REQUEST,
          `Only ${formatBDT(remaining)} of this top-up is left to refund`,
        );
      }

      const n = attempts + 1;

      // Refuses with "Insufficient available balance" when the customer has
      // spent or holds the money: the gateway is then never called.
      await WalletService.mutate(
        {
          userId: intent.userId,
          type: WalletTxType.TOPUP_REVERSAL,
          amount: -amount,
          description: `Refund to ${provider.displayName}`,
          referenceType: REFUND_REFERENCE,
          referenceId: intent.id,
          idempotencyKey: `refund:${intent.id}:${n}`,
          metadata: {
            transactionId: intent.transactionId,
            gatewayRef,
            provider: intent.provider,
            reason,
            byAdmin: adminId,
            gatewayEnv: provider.isTestMode() ? "sandbox" : "live",
          },
        },
        tx,
      );

      return { amount, remainingMinor: remaining - amount, n };
    },
    { maxWait: 10_000, timeout: 20_000 },
  );

  // 2. Ask the gateway, outside any transaction: the call can take 30 s.
  let result: { ok: boolean; refundRef?: string; message?: string; unknown?: boolean };
  try {
    result = await provider.refund({
      sessionKey: intent.sessionKey,
      gatewayRef,
      amountMinor: amount,
      reason,
    });
  } catch (error) {
    // Something threw after the request may have left: not a definite "no".
    result = { ok: false, unknown: true, message: (error as Error)?.message };
  }

  const entry = { n, amountMinor: amount, at: new Date().toISOString(), by: adminId };

  if (result.ok) {
    const refundRef = result.refundRef ?? null;
    await recordRefund(intent.id, { ...entry, refundRef, status: "COMPLETED" });
    return { refundedMinor: amount, remainingMinor, status: "COMPLETED" as RefundStatus, refundRef };
  }

  if (result.unknown) {
    await recordRefund(intent.id, { ...entry, status: "UNKNOWN", message: result.message ?? null });
    console.error(
      `[payment.refund] needs manual check: intent=${intent.id} tran=${intent.transactionId} refund #${n} of ${amount} poisha via ${intent.provider} (${gatewayRef}) - ${result.message}. The wallet was debited; confirm in the merchant portal before touching it.`,
    );
    return { refundedMinor: amount, remainingMinor, status: "UNKNOWN" as RefundStatus, refundRef: null };
  }

  // 3. A definite "no": the money never left, so give it back.
  const message = result.message || `${provider.displayName} refused the refund`;
  try {
    await WalletService.mutate({
      userId: intent.userId,
      type: WalletTxType.ADJUSTMENT,
      amount,
      description: `Refund failed: ${message}`,
      referenceType: REFUND_REFERENCE,
      referenceId: intent.id,
      idempotencyKey: `refund-undo:${intent.id}:${n}`,
      metadata: {
        transactionId: intent.transactionId,
        gatewayRef,
        provider: intent.provider,
        reason: message,
        byAdmin: adminId,
      },
    });
  } catch (error) {
    console.error(
      `[payment.refund] intent=${intent.id} refund #${n} was refused but ${amount} poisha could not be put back in the wallet - needs a manual adjustment`,
      error,
    );
    throw error;
  }

  await recordRefund(intent.id, { ...entry, status: "FAILED", message });
  throw new ApiError(StatusCodes.BAD_GATEWAY, message);
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const getMyIntents = async (userId: string, query: any) => {
  const { page = 1, limit = 20, status } = query;
  const pageNum = Number(page);
  const limitNum = Number(limit);

  const where: Prisma.PaymentIntentWhereInput = { userId };
  if (status) where.status = status as IntentStatus;

  const [data, total] = await Promise.all([
    prisma.paymentIntent.findMany({
      where,
      skip: (pageNum - 1) * limitNum,
      take: limitNum,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        transactionId: true,
        purpose: true,
        amountMinor: true,
        status: true,
        provider: true,
        method: true,
        failureReason: true,
        completedAt: true,
        createdAt: true,
      },
    }),
    prisma.paymentIntent.count({ where }),
  ]);

  return { meta: { page: pageNum, limit: limitNum, total }, data };
};

/**
 * The customer is back from the gateway on the success url. The IPN is still
 * the authority, but waiting for it is what leaves someone watching a spinner,
 * so settle here too: first from the signed redirect body, then - if that did
 * not close the intent - by asking the gateway outright.
 */
const settleFromSuccessRedirect = async (payload: Record<string, string>) => {
  if (!payload?.tran_id) return;

  try {
    await processIpn(payload);
  } catch (error) {
    console.error(
      `[payment.success-redirect] IPN path failed for tran_id=${payload.tran_id}`,
      error,
    );
  }

  await resolveByTransactionId(payload.tran_id);
};

/**
 * Lets the frontend poll after a redirect instead of guessing. It backs the
 * result page, so it carries everything that page shows: the gateway's own
 * reference, the method used, and the balance the top-up produced.
 */
const getIntentStatus = async (userId: string, transactionId: string) => {
  const intent = await prisma.paymentIntent.findUnique({
    where: { transactionId },
    select: {
      userId: true,
      transactionId: true,
      purpose: true,
      amountMinor: true,
      status: true,
      provider: true,
      method: true,
      gatewayRef: true,
      failureReason: true,
      completedAt: true,
      createdAt: true,
    },
  });

  if (!intent || intent.userId !== userId) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Payment not found");
  }

  const { userId: _ownerId, ...rest } = intent;

  const wallet = await prisma.wallet.findUnique({
    where: { userId },
    select: { balance: true, heldBalance: true },
  });

  return {
    ...rest,
    // Saves the result page a second round-trip to show the new balance.
    walletAvailableMinor: wallet ? wallet.balance - wallet.heldBalance : 0,
  };
};

export const PaymentIntentService = {
  initiateTopup,
  processIpn,
  settleFromSuccessRedirect,
  resolveByTransactionId,
  settleBkashCallback,
  listPaymentMethods,
  markIntentFailed,
  reconcilePendingIntents,
  refundTopup,
  getMyIntents,
  getIntentStatus,
  MIN_TOPUP_MINOR,
  MAX_TOPUP_MINOR,
};
