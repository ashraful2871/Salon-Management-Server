/**
 * What a bKash error code means for us. `ambiguous` is the one that matters:
 * the money may or may not have moved, so the only safe next step is to ask
 * bKash (query), never to mark the intent failed.
 */
export type BkashErrorKind =
  | "business"
  | "ambiguous"
  | "integration"
  | "config"
  | "availability"
  | "unknown";

const TABLE: Record<string, { kind: BkashErrorKind; customer: string }> = {
  "2023": {
    kind: "business",
    customer: "Your bKash balance is too low for this top-up. Nothing was charged.",
  },
  "2029": {
    kind: "business",
    customer:
      "bKash blocked this as a repeat of a payment you just made. Wait a couple of minutes and try again.",
  },
  "2006": { kind: "business", customer: "bKash did not accept this amount." },
  "2002": {
    kind: "integration",
    customer: "We couldn't confirm this bKash payment. Nothing was charged.",
  },
  "2031": {
    kind: "integration",
    customer: "We couldn't confirm this bKash payment. Nothing was charged.",
  },
  "2001": {
    kind: "config",
    customer: "bKash is unavailable right now. Please try another method.",
  },
  "503": {
    kind: "availability",
    customer: "bKash is under maintenance. Try again later or pay another way.",
  },
};

const AMBIGUOUS = new Set(["2056", "2062", "TIMEOUT", "NETWORK", "BAD_RESPONSE"]);

export const classifyBkashError = (
  code: string,
): { kind: BkashErrorKind; customer: string } => {
  if (AMBIGUOUS.has(code)) {
    return { kind: "ambiguous", customer: "We're confirming your payment with bKash." };
  }
  return (
    TABLE[code] ?? { kind: "unknown", customer: "bKash could not complete the payment." }
  );
};

/** The `failureReason` format: the customer's sentence plus the code support needs. */
export const bkashFailureReason = (code: string, _message?: string) =>
  `${classifyBkashError(code).customer} (bKash ${code})`;
