import { StatusCodes } from "http-status-codes";
import ApiError from "../../../../Error/error";
import config from "../../../../../config";
import { parseGatewayAmount, toGatewayAmount } from "../amount";
import { GatewayLookup, GatewayState, PaymentProvider } from "../types";
import { BkashErr, BkashResult, bkashRequest, redactBkash } from "./bkash.client";
import { bkashFailureReason, classifyBkashError } from "./bkash.errors";

export { maskMsisdn } from "./bkash.client";

/** Execute and query answer with the same shape. */
export type BkashPayment = {
  paymentID?: string;
  trxID?: string;
  transactionStatus?: string;
  amount?: string;
  currency?: string;
  intent?: string;
  merchantInvoiceNumber?: string;
  customerMsisdn?: string;
  paymentExecuteTime?: string;
};

type BkashCreate = {
  paymentID?: string;
  bkashURL?: string;
  transactionStatus?: string;
};

/** bKash forgets an unexecuted paymentID after this long. */
const PAYMENT_ID_TTL_MS = 24 * 60 * 60 * 1000;
const BD_MOBILE = /^01[3-9]\d{8}$/;

/**
 * Whether an execute (or query) result really is the payment we asked for.
 * Pure on purpose, so the checks can be run offline.
 */
export const verifyBkashSettlement = (
  intent: { transactionId: string; amountMinor: number },
  r: BkashPayment,
): { ok: true } | { ok: false; reason: string } => {
  if (r.transactionStatus !== "Completed") {
    return { ok: false, reason: `bKash reported ${r.transactionStatus ?? "no status"}` };
  }
  if (parseGatewayAmount(r.amount) !== intent.amountMinor) {
    return { ok: false, reason: "Amount mismatch" };
  }
  if (r.currency !== "BDT") return { ok: false, reason: "Currency mismatch" };
  if (r.merchantInvoiceNumber !== intent.transactionId) {
    return { ok: false, reason: "Invoice mismatch" };
  }
  return { ok: true };
};

type BkashRefund = {
  originalTrxId?: string;
  refundTrxId?: string;
  refundTransactionStatus?: string;
  refundAmount?: string;
};

/**
 * Whether a failed refund may still have gone through. Only a definite "no"
 * lets the caller give the customer's wallet the money back: undoing a refund
 * that actually happened would pay them twice.
 */
const refundMayHaveHappened = (r: BkashErr) => {
  if (r.notSent) return false;
  if (r.timeout || r.httpStatus === undefined || r.httpStatus >= 500) return true;
  // bKash rejected the request itself, so it was not processed.
  if (r.httpStatus >= 400) return false;
  // A 2xx that is not "Completed": no error code (a refund still in progress),
  // unreadable, or one of the codes that mean "maybe".
  return (
    r.code === "0000" ||
    r.code.startsWith("HTTP_") ||
    classifyBkashError(r.code).kind === "ambiguous"
  );
};

const STATE_REASON: Partial<Record<GatewayState, string>> = {
  CANCELLED: "The bKash payment was cancelled.",
  FAILED: "The bKash payment did not complete.",
  EXPIRED: "The bKash payment expired before it was completed.",
};

export const bkashProvider: PaymentProvider & {
  execute(paymentID: string, tran: string): Promise<BkashResult<BkashPayment>>;
} = {
  name: "BKASH",
  displayName: "bKash",

  isEnabled: () =>
    config.bkash.enabled &&
    Boolean(
      config.bkash.username &&
        config.bkash.password &&
        config.bkash.appKey &&
        config.bkash.appSecret,
    ),

  isTestMode: () => !config.bkash.isLive,

  async createSession({ transactionId, amountMinor, customer }) {
    const r = await bkashRequest<BkashCreate>(
      "/create",
      {
        mode: "0011",
        payerReference:
          customer.phone && BD_MOBILE.test(customer.phone) ? customer.phone : "SalonKhuji",
        callbackURL: config.bkash.callbackUrl,
        amount: toGatewayAmount(amountMinor),
        currency: "BDT",
        intent: "sale",
        merchantInvoiceNumber: transactionId,
      },
      { auth: "token", op: "create", tran: transactionId },
    );

    if (!r.ok || !r.data.paymentID || !r.data.bkashURL) {
      const code = r.ok ? "BAD_RESPONSE" : r.code;
      const { kind, customer: message } = classifyBkashError(code);
      // Create moves no money, so "we're confirming your payment" would be
      // wrong here: nothing was paid yet.
      throw new ApiError(
        StatusCodes.BAD_GATEWAY,
        kind === "ambiguous"
          ? "We couldn't reach bKash. Nothing was charged. Please try again."
          : message,
      );
    }

    return { redirectUrl: r.data.bkashURL, sessionKey: r.data.paymentID };
  },

  async lookup(intent): Promise<GatewayLookup> {
    if (!intent.sessionKey) {
      return {
        state: "FAILED",
        amountMinor: 0,
        invoice: null,
        gatewayRef: null,
        method: "bKash",
        reason: "No bKash payment was created",
        raw: null,
      };
    }

    const r = await bkashRequest<BkashPayment>(
      "/payment/status",
      { paymentID: intent.sessionKey },
      { auth: "token", op: "query", tran: intent.transactionId },
    );

    if (!r.ok) {
      if (r.code === "2002") {
        return {
          state: "FAILED",
          amountMinor: 0,
          invoice: null,
          gatewayRef: null,
          method: "bKash",
          reason: bkashFailureReason(r.code, r.message),
          raw: { errorCode: r.code, errorMessage: r.message },
        };
      }
      // Callers leave the intent PENDING; reconciliation asks again later.
      throw new Error(`bKash query failed (${r.code})`);
    }

    const d = r.data;
    let state: GatewayState;
    switch (d.transactionStatus) {
      case "Completed":
        state = "SETTLED";
        break;
      case "Cancelled":
        state = "CANCELLED";
        break;
      case "Failed":
        state = "FAILED";
        break;
      default:
        // Initiated (the customer has not finished) or another in-flight state.
        state =
          Date.now() - intent.createdAt.getTime() >= PAYMENT_ID_TTL_MS ? "EXPIRED" : "PENDING";
    }

    return {
      state,
      amountMinor: parseGatewayAmount(d.amount),
      invoice: d.merchantInvoiceNumber ?? null,
      gatewayRef: d.trxID ?? null,
      method: "bKash",
      reason: STATE_REASON[state],
      raw: redactBkash(d),
    };
  },

  /**
   * Refund v2. It lives outside /v1.2.0-beta, at the origin of the base URL.
   * Up to 10 partial refunds per transaction.
   */
  async refund({ sessionKey, gatewayRef, amountMinor, reason }) {
    if (!sessionKey) {
      return { ok: false, message: "This bKash payment has no paymentID to refund against" };
    }

    const r = await bkashRequest<BkashRefund>(
      `${new URL(config.bkash.baseUrl).origin}/v2/tokenized-checkout/refund/payment/transaction`,
      {
        paymentId: sessionKey,
        trxId: gatewayRef,
        refundAmount: toGatewayAmount(amountMinor),
        sku: "wallet-topup",
        reason,
      },
      {
        auth: "token",
        op: "refund",
        tran: gatewayRef,
        absolute: true,
        accept: (d) => d.refundTransactionStatus === "Completed",
      },
    );

    if (r.ok) return { ok: true, refundRef: r.data.refundTrxId, message: "Completed" };

    return {
      ok: false,
      message: `${r.message} (bKash ${r.code})`,
      unknown: refundMayHaveHappened(r) || undefined,
    };
  },

  /** Captures the money. A paymentID executes once. */
  execute: (paymentID, tran) =>
    bkashRequest<BkashPayment>("/execute", { paymentID }, { auth: "token", op: "execute", tran }),
};
