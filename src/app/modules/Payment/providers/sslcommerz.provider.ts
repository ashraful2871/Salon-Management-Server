import crypto from "crypto";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../../Error/error";
import config from "../../../../config";
import { parseGatewayAmount, toGatewayAmount } from "./amount";
import { GatewayLookup, PaymentProvider } from "./types";

/**
 * SSLCommerz v4.
 *
 * Field names and endpoints follow the integration SSLCommerz documents in the
 * merchant panel. Confirm them against your own panel before going live -
 * treat this as a working starting point, not gospel.
 */
const BASE = config.sslcz.isLive
  ? "https://securepay.sslcommerz.com"
  : "https://sandbox.sslcommerz.com";

const SESSION_ENDPOINT = `${BASE}/gwprocess/v4/api.php`;
const VALIDATION_ENDPOINT = `${BASE}/validator/api/validationserverAPI.php`;
const TRANSACTION_QUERY_ENDPOINT = `${BASE}/validator/api/merchantTransIDvalidationAPI.php`;

/** A gateway that hangs must not hold a request (or the reconcile sweep) open. */
const TIMEOUT_MS = 30_000;

const md5 = (value: string) =>
  crypto.createHash("md5").update(value).digest("hex");

const assertConfigured = () => {
  if (!config.sslcz.storeId || !config.sslcz.storePasswd) {
    throw new ApiError(
      StatusCodes.SERVICE_UNAVAILABLE,
      "Online payment is not configured. Set SSLCZ_STORE_ID and SSLCZ_STORE_PASSWD.",
    );
  }
};

type SslValidation = {
  valid: boolean;
  transactionId: string;
  amountMinor: number;
  gatewayRef: string;
  method: string | null;
  raw: unknown;
};

type SslTransactionQuery = SslValidation & {
  settled: boolean;
  status: string;
};

/**
 * SSLCommerz-only extras on top of the shared seam: the IPN path needs the
 * signature check and val_id validation, which no other gateway has.
 */
export type SslCommerzProvider = PaymentProvider & {
  /**
   * Independently re-query the gateway. NEVER trust the callback body: the
   * signature proves the message came from the gateway, this proves the money
   * actually settled.
   */
  validate(valId: string): Promise<SslValidation>;
  /** Re-query by our own transaction id, for intents that never got an IPN. */
  validateByTransactionId(transactionId: string): Promise<SslTransactionQuery>;
  verifySignature(payload: Record<string, string>): boolean;
};

export const sslCommerzProvider: SslCommerzProvider = {
  name: "SSLCOMMERZ",
  displayName: "SSLCommerz",

  isEnabled: () => Boolean(config.sslcz.storeId && config.sslcz.storePasswd),

  isTestMode: () => !config.sslcz.isLive,

  async createSession({ transactionId, amountMinor, customer, purpose }) {
    assertConfigured();

    const body = new URLSearchParams({
      store_id: config.sslcz.storeId,
      store_passwd: config.sslcz.storePasswd,
      total_amount: toGatewayAmount(amountMinor),
      currency: "BDT",
      tran_id: transactionId,
      success_url: config.sslcz.successUrl,
      fail_url: config.sslcz.failUrl,
      cancel_url: config.sslcz.cancelUrl,
      ipn_url: config.sslcz.ipnUrl,
      cus_name: customer.name,
      cus_email: customer.email,
      // SSLCommerz rejects a session without a phone number.
      cus_phone: customer.phone ?? "01700000000",
      cus_add1: "N/A",
      cus_city: "Dhaka",
      cus_country: "Bangladesh",
      shipping_method: "NO",
      product_name:
        purpose === "WALLET_TOPUP" ? "Wallet Top-up" : "Salon Booking",
      product_category: "Service",
      product_profile: "general",
    });

    const response = await fetch(SESSION_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const json: any = await response.json();

    if (json?.status !== "SUCCESS" || !json?.GatewayPageURL) {
      throw new ApiError(
        StatusCodes.BAD_GATEWAY,
        json?.failedreason || "Could not start the payment session",
      );
    }

    return {
      redirectUrl: json.GatewayPageURL as string,
      sessionKey: json.sessionkey as string,
    };
  },

  async validate(valId: string) {
    assertConfigured();

    const url = new URL(VALIDATION_ENDPOINT);
    url.searchParams.set("val_id", valId);
    url.searchParams.set("store_id", config.sslcz.storeId);
    url.searchParams.set("store_passwd", config.sslcz.storePasswd);
    url.searchParams.set("format", "json");

    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const json: any = await response.json();

    return {
      valid: json?.status === "VALID" || json?.status === "VALIDATED",
      transactionId: json?.tran_id,
      amountMinor: parseGatewayAmount(json?.amount),
      gatewayRef: json?.bank_tran_id,
      method: json?.card_type ?? null,
      raw: json,
    };
  },

  /**
   * Used by the reconciliation job for intents that never received an IPN -
   * the customer closed the browser mid-payment, or the webhook was dropped.
   */
  async validateByTransactionId(transactionId: string) {
    assertConfigured();

    const url = new URL(TRANSACTION_QUERY_ENDPOINT);
    url.searchParams.set("tran_id", transactionId);
    url.searchParams.set("store_id", config.sslcz.storeId);
    url.searchParams.set("store_passwd", config.sslcz.storePasswd);
    url.searchParams.set("format", "json");

    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const json: any = await response.json();

    // The endpoint answers with every element matching the transaction id; the
    // most recent one is the state that counts.
    const element = Array.isArray(json?.element) ? json.element[0] : undefined;
    const status = element?.status ?? json?.status ?? "UNKNOWN";
    const settled = status === "VALID" || status === "VALIDATED";

    return {
      valid: Boolean(element),
      settled,
      transactionId: element?.tran_id ?? transactionId,
      amountMinor: parseGatewayAmount(element?.amount),
      gatewayRef: element?.bank_tran_id,
      method: element?.card_type ?? null,
      status,
      raw: json,
    };
  },

  /**
   * How SSLCommerz names the ways a payment can end, mapped onto ours.
   * Anything unrecognised is a failure - never a silent success.
   */
  async lookup(intent): Promise<GatewayLookup> {
    const result = await sslCommerzProvider.validateByTransactionId(
      intent.transactionId,
    );
    const raw = result.raw as any;
    const element = Array.isArray(raw?.element) ? raw.element[0] : undefined;
    const status = String(result.status);

    const base = {
      amountMinor: result.amountMinor,
      invoice: (element?.tran_id as string | undefined) ?? null,
      gatewayRef: result.gatewayRef ?? null,
      method: result.method,
      raw: result.raw,
    };

    if (result.settled) return { ...base, state: "SETTLED" };

    switch (status.toUpperCase()) {
      case "PENDING":
      case "PROCESSING":
        return { ...base, state: "PENDING" };
      case "CANCELLED":
      case "CANCELED":
        return { ...base, state: "CANCELLED" };
      case "EXPIRED":
      case "UNATTEMPTED":
        // Keeps the failureReason the intent got before the seam existed.
        return { ...base, state: "EXPIRED", reason: `Gateway reported ${status}` };
      default:
        return { ...base, state: "FAILED", reason: `Gateway reported ${status}` };
    }
  },

  /**
   * The documented hash check: rebuild the signed string from the fields
   * `verify_key` names, append the md5 of the store password, sort, and compare.
   *
   * A valid signature only proves the message came from SSLCommerz. It does
   * not prove the money settled - always call `validate()` before crediting.
   */
  verifySignature(payload: Record<string, string>): boolean {
    const verifySign = payload?.verify_sign;
    const verifyKey = payload?.verify_key;

    if (!verifySign || !verifyKey || !config.sslcz.storePasswd) return false;

    const fields: Record<string, string> = {};

    for (const key of verifyKey.split(",")) {
      const name = key.trim();
      if (!name) continue;
      fields[name] = payload[name] ?? "";
    }

    fields.store_passwd = md5(config.sslcz.storePasswd);

    const hashString = Object.keys(fields)
      .sort()
      .map((key) => `${key}=${fields[key]}`)
      .join("&");

    const expected = md5(hashString);

    // Constant-time compare - the lengths are fixed, so this is cheap.
    const a = Buffer.from(expected);
    const b = Buffer.from(verifySign);

    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },

  async refund({ gatewayRef, amountMinor, reason }) {
    try {
      assertConfigured();
    } catch (err) {
      // Nothing was sent, so this is a plain "no".
      return { ok: false, message: (err as Error).message };
    }

    const url = new URL(TRANSACTION_QUERY_ENDPOINT);
    url.searchParams.set("bank_tran_id", gatewayRef);
    url.searchParams.set("store_id", config.sslcz.storeId);
    url.searchParams.set("store_passwd", config.sslcz.storePasswd);
    url.searchParams.set("refund_amount", toGatewayAmount(amountMinor));
    url.searchParams.set("refund_remarks", reason);
    url.searchParams.set("format", "json");

    // A timeout, a dropped connection or an unreadable answer means the refund
    // may have been accepted, so it is `unknown`, never a plain failure.
    let json: any;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      json = await response.json();
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      return {
        ok: false,
        unknown: true,
        message:
          name === "TimeoutError" || name === "AbortError"
            ? "SSLCommerz did not answer in time"
            : "Could not read SSLCommerz's answer",
      };
    }

    const ok = json?.APIConnect === "DONE" && json?.status === "success";

    return {
      ok,
      refundRef: json?.refund_ref_id,
      message: json?.errorReason ?? json?.status,
      // "processing": a refund on this payment is already under way.
      unknown: (!json || (json.APIConnect === "DONE" && json.status === "processing")) || undefined,
    };
  },
};
