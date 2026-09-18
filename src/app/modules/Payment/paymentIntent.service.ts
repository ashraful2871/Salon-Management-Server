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
import { getWalletTopupTemplate } from "../../utils/emailTemplates";
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

const markIntentFailed = async (transactionId: string, reason: string) => {
  await prisma.paymentIntent.updateMany({
    // Never walk back a success: an intent that already credited stays credited.
    where: {
      transactionId,
      status: { in: [IntentStatus.INITIATED, IntentStatus.PENDING] },
    },
    data: { status: IntentStatus.FAILED, failureReason: reason },
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
  await prisma.$transaction(async (tx) => {
    await tx.paymentIntent.update({
      where: { id: intent.id },
      data: {
        status: IntentStatus.SUCCESS,
        gatewayRef: settled.gatewayRef,
        method: settled.method,
        rawResponse: settled.raw as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });

    if (intent.purpose === IntentPurpose.WALLET_TOPUP) {
      await WalletService.mutate(
        {
          userId: intent.userId,
          type: WalletTxType.TOPUP,
          amount: intent.amountMinor,
          description: `Top-up via ${settled.method ?? provider.name}`,
          referenceType: "TOPUP",
          referenceId: intent.id,
          // The final replay guard: even if every check above is passed twice,
          // this key means the money only lands once.
          idempotencyKey: `topup:${intent.transactionId}`,
        },
        tx,
      );
    }
  });

  notifyTopupSuccess(intent);
};

const notifyTopupSuccess = (intent: PaymentIntent) => {
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
        "Wallet top-up successful",
        getWalletTopupTemplate(
          user.name || "there",
          formatBDT(intent.amountMinor),
          formatBDT(wallet.balance - wallet.heldBalance),
        ),
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
      const result = await provider.validateByTransactionId(
        intent.transactionId,
      );

      if (result.settled && result.amountMinor === intent.amountMinor) {
        await creditSettledIntent(intent, {
          gatewayRef: result.gatewayRef,
          method: result.method,
          raw: result.raw,
        });
        credited += 1;
        continue;
      }

      if (result.settled) {
        console.error(
          `[payment.reconcile] amount mismatch on intent=${intent.id}: expected ${intent.amountMinor}, got ${result.amountMinor}`,
        );
        await markIntentFailed(intent.transactionId, "Amount mismatch");
        failed += 1;
        continue;
      }

      // Still genuinely in flight at the gateway - leave it for the next pass.
      if (result.status === "PENDING" || result.status === "PROCESSING") {
        if (Date.now() - intent.createdAt.getTime() > ALERT_AFTER_MS) {
          console.error(
            `[payment.reconcile] intent=${intent.id} has been pending for over 24h - needs manual review`,
          );
        }
        continue;
      }

      await markIntentFailed(
        intent.transactionId,
        `Gateway reported ${result.status}`,
      );
      failed += 1;
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

/** Lets the frontend poll after a redirect instead of guessing. */
const getIntentStatus = async (userId: string, transactionId: string) => {
  const intent = await prisma.paymentIntent.findUnique({
    where: { transactionId },
    select: {
      userId: true,
      transactionId: true,
      purpose: true,
      amountMinor: true,
      status: true,
      method: true,
      failureReason: true,
      completedAt: true,
    },
  });

  if (!intent || intent.userId !== userId) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Payment not found");
  }

  const { userId: _ownerId, ...rest } = intent;
  return rest;
};

export const PaymentIntentService = {
  initiateTopup,
  processIpn,
  markIntentFailed,
  reconcilePendingIntents,
  getMyIntents,
  getIntentStatus,
  MIN_TOPUP_MINOR,
  MAX_TOPUP_MINOR,
};
