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
import { sslCommerzProvider } from "./providers/sslcommerz.provider";
import { PaymentProvider } from "./providers/types";

const provider: PaymentProvider = sslCommerzProvider;

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

const initiateTopup = async (userId: string, amountMinor: number) => {
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
    gatewayRef: string;
    method: string | null;
    raw: unknown;
  },
) => {
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
          description: `Top-up via ${settled.method ?? provider.name}`,
          referenceType: "TOPUP",
          referenceId: intent.id,
          // The wallet history renders these. Without them a ledger row has no
          // way back to the gateway payment that produced it, and the customer
          // has no id to quote to support.
          metadata: {
            transactionId: intent.transactionId,
            gatewayRef: settled.gatewayRef ?? null,
            method: settled.method ?? null,
            provider: provider.name,
          },
          // The final replay guard: even if every check above is passed twice,
          // this key means the money only lands once.
          idempotencyKey: `topup:${intent.transactionId}`,
        },
        tx,
      );
    }

    return true;
  });

  if (credited) notifyTopupSuccess(intent, settled);
};

const notifyTopupSuccess = (
  intent: PaymentIntent,
  settled: { gatewayRef: string | null; method: string | null },
) => {
  if (intent.purpose !== IntentPurpose.WALLET_TOPUP) return;

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
          method: settled.method ?? provider.name,
          gatewayRef: settled.gatewayRef ?? null,
          paidAt: new Date(),
          provider: provider.name,
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
  if (!provider.verifySignature(payload)) {
    console.warn(
      `[payment.ipn] signature verification failed for tran_id=${payload?.tran_id}`,
    );
    return;
  }

  if (!payload.val_id) {
    console.warn(`[payment.ipn] no val_id for tran_id=${payload?.tran_id}`);
    return;
  }

  const result = await provider.validate(payload.val_id);

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
 * How SSLCommerz names the ways a payment can end, mapped onto our own terminal
 * statuses. Anything unrecognised is a failure - never a silent success.
 */
const terminalStatusFor = (gatewayStatus: string): TerminalStatus => {
  switch (gatewayStatus?.toUpperCase()) {
    case "CANCELLED":
    case "CANCELED":
      return IntentStatus.CANCELLED;
    case "EXPIRED":
    case "UNATTEMPTED":
      return IntentStatus.EXPIRED;
    default:
      return IntentStatus.FAILED;
  }
};

/**
 * Settle one intent against the gateway's own record of it.
 *
 * This is the path for every case where the IPN is not what tells us how a
 * payment ended: the reconciliation sweep, and the fail/cancel redirect - whose
 * POST body anyone could hand-craft, so it is never trusted to close an intent
 * by itself. Returns the status the intent now has.
 */
const settleFromGateway = async (intent: PaymentIntent) => {
  const result = await provider.validateByTransactionId(intent.transactionId);

  if (result.settled && result.amountMinor === intent.amountMinor) {
    await creditSettledIntent(intent, {
      gatewayRef: result.gatewayRef,
      method: result.method,
      raw: result.raw,
    });
    return IntentStatus.SUCCESS;
  }

  if (result.settled) {
    console.error(
      `[payment.settle] amount mismatch on intent=${intent.id}: expected ${intent.amountMinor}, got ${result.amountMinor}`,
    );
    await markIntentFailed(intent.transactionId, "Amount mismatch");
    return IntentStatus.FAILED;
  }

  // Still genuinely in flight at the gateway - leave it alone.
  if (result.status === "PENDING" || result.status === "PROCESSING") {
    return intent.status;
  }

  const status = terminalStatusFor(result.status);
  await markIntentFailed(
    intent.transactionId,
    status === IntentStatus.CANCELLED
      ? "Payment cancelled at the gateway"
      : `Gateway reported ${result.status}`,
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
  markIntentFailed,
  reconcilePendingIntents,
  getMyIntents,
  getIntentStatus,
  MIN_TOPUP_MINOR,
  MAX_TOPUP_MINOR,
};
