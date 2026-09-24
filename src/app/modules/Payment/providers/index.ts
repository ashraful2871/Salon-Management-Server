import { StatusCodes } from "http-status-codes";
import ApiError from "../../../Error/error";
import { bkashProvider } from "./bkash/bkash.provider";
import { sslCommerzProvider } from "./sslcommerz.provider";
import { PaymentProvider, ProviderName, PROVIDER_NAMES } from "./types";

/**
 * Every gateway the core can dispatch to, keyed by the name stored on
 * `PaymentIntent.provider`. An intent always goes back to the gateway that
 * created it - never to whichever one happens to be the default.
 */
const registry: Partial<Record<ProviderName, PaymentProvider>> = {
  BKASH: bkashProvider,
  SSLCOMMERZ: sslCommerzProvider,
};

export const isProviderName = (x: unknown): x is ProviderName =>
  x === "SSLCOMMERZ" || x === "BKASH";

export const getProvider = (name: string): PaymentProvider => {
  const p = isProviderName(name) ? registry[name] : undefined;
  if (!p) {
    throw new ApiError(
      StatusCodes.SERVICE_UNAVAILABLE,
      `${name === "BKASH" ? "bKash" : "This payment method"} is not available right now`,
    );
  }
  return p;
};

export const listProviders = () =>
  PROVIDER_NAMES.map((n) => registry[n]).filter(Boolean) as PaymentProvider[];
