import { z } from "zod";

/**
 * The API speaks taka, like every other money field the frontend already
 * sends. Poisha is a storage detail - controllers convert at the boundary with
 * `toMinor`, so a fractional poisha can never get in.
 */
const takaAmount = z
  .number()
  .refine((value) => Number.isFinite(value), { message: "Amount is required" })
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9, {
    message: "Amount cannot be smaller than one poisha (0.01)",
  });

const topupValidation = z.object({
  body: z.object({
    amount: takaAmount.refine((value) => value > 0, {
      message: "Top-up amount must be positive",
    }),
  }),
});

const adminAdjustValidation = z.object({
  body: z.object({
    userId: z.string().nonempty({ message: "User ID is required" }),
    // Signed: a negative amount is a debit correction.
    amount: takaAmount.refine((value) => value !== 0, {
      message: "Adjustment amount cannot be zero",
    }),
    reason: z
      .string()
      .trim()
      .nonempty({ message: "A reason is required for a manual adjustment" }),
  }),
});

export const WalletValidation = {
  topupValidation,
  adminAdjustValidation,
};
