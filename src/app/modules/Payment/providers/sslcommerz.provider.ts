import crypto from "crypto";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../../Error/error";
import config from "../../../../config";
import { toTaka } from "../../../utils/money";
import { PaymentProvider } from "./types";

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

/** The gateway speaks taka with two decimals; we hold poisha. */
const toGatewayAmount = (amountMinor: number) => toTaka(amountMinor).toFixed(2);

const parseGatewayAmount = (amount: unknown): number => {
  const parsed = parseFloat(String(amount));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
};

export const sslCommerzProvider: PaymentProvider = {
  name: "SSLCOMMERZ",

  async initSession({ transactionId, amountMinor, customer, purpose }) {
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
      cus_phone: customer.phone,
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

    const response = await fetch(url);
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

    const response = await fetch(url);
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

  async refund(gatewayRef: string, amountMinor: number, reason: string) {
    assertConfigured();

    const url = new URL(TRANSACTION_QUERY_ENDPOINT);
    url.searchParams.set("bank_tran_id", gatewayRef);
    url.searchParams.set("store_id", config.sslcz.storeId);
    url.searchParams.set("store_passwd", config.sslcz.storePasswd);
    url.searchParams.set("refund_amount", toGatewayAmount(amountMinor));
    url.searchParams.set("refund_remarks", reason);
    url.searchParams.set("format", "json");

    const response = await fetch(url);
    const json: any = await response.json();

    const ok = json?.APIConnect === "DONE" && json?.status === "success";

    return {
      ok,
      refundRef: json?.refund_ref_id,
      message: json?.errorReason ?? json?.status,
    };
  },
};
