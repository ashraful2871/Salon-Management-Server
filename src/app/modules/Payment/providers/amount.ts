import { toTaka } from "../../../utils/money";

/** The gateway speaks taka with two decimals; we hold poisha. */
export const toGatewayAmount = (amountMinor: number) => toTaka(amountMinor).toFixed(2);

export const parseGatewayAmount = (amount: unknown): number => {
  const parsed = parseFloat(String(amount));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
};
