/**
 * The gateway seam. SSLCommerz and bKash direct both sit behind it, and
 * adding another gateway should never require touching the wallet or the
 * booking flow.
 */
import { PaymentIntent } from "@prisma/client";

export type ProviderName = "SSLCOMMERZ" | "BKASH";
/** Order the frontend shows them in. */
export const PROVIDER_NAMES: ProviderName[] = ["BKASH", "SSLCOMMERZ"];

/** How a gateway says a payment ended, in our words. */
export type GatewayState = "SETTLED" | "PENDING" | "FAILED" | "CANCELLED" | "EXPIRED";

export type GatewayLookup = {
  state: GatewayState;
  amountMinor: number;
  invoice: string | null;      // our transactionId as the gateway echoes it (null = gateway does not echo it)
  gatewayRef: string | null;   // SSLCommerz bank_tran_id | bKash trxID
  method: string | null;
  reason?: string;             // gateway's own words, for failureReason
  raw: unknown;                // already redacted
};

export type IntentRef = Pick<PaymentIntent, "transactionId" | "sessionKey" | "createdAt">;

export interface PaymentProvider {
  readonly name: ProviderName;
  readonly displayName: string;
  isEnabled(): boolean;
  isTestMode(): boolean;
  createSession(args: {
    transactionId: string;
    amountMinor: number;
    customer: { name: string; email: string; phone: string | null };
    purpose: "WALLET_TOPUP" | "BOOKING";
  }): Promise<{ redirectUrl: string; sessionKey: string }>;
  /** Independent re-query. Never trusts anything the browser carried. */
  lookup(intent: IntentRef): Promise<GatewayLookup>;
  refund?(args: {
    sessionKey: string | null;
    gatewayRef: string;
    amountMinor: number;
    reason: string;
  }): Promise<{ ok: boolean; refundRef?: string; message?: string; unknown?: boolean }>;
}
