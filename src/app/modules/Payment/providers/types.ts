/**
 * The gateway seam. SSLCommerz is what we launch with, but bKash and Nagad
 * direct integrations are the obvious next step, and neither should require
 * touching the wallet or the booking flow.
 */
export interface PaymentProvider {
  readonly name: string;

  initSession(args: {
    transactionId: string;
    amountMinor: number;
    customer: { name: string; email: string; phone: string };
    purpose: "WALLET_TOPUP" | "BOOKING";
  }): Promise<{ redirectUrl: string; sessionKey: string }>;

  /**
   * Independently re-query the gateway. NEVER trust the callback body: the
   * signature proves the message came from the gateway, this proves the money
   * actually settled.
   */
  validate(valId: string): Promise<{
    valid: boolean;
    transactionId: string;
    amountMinor: number;
    gatewayRef: string;
    method: string | null;
    raw: unknown;
  }>;

  /** Re-query by our own transaction id, for intents that never got an IPN. */
  validateByTransactionId(transactionId: string): Promise<{
    valid: boolean;
    settled: boolean;
    transactionId: string;
    amountMinor: number;
    gatewayRef: string;
    method: string | null;
    status: string;
    raw: unknown;
  }>;

  verifySignature(payload: Record<string, string>): boolean;

  refund(
    gatewayRef: string,
    amountMinor: number,
    reason: string,
  ): Promise<{ ok: boolean; refundRef?: string; message?: string }>;
}
