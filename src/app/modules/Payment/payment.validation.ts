import { z } from "zod";
import { takaAmount } from "../Wallet/wallet.validation";

/**
 * Note what is *not* here: an amount and a status. Both are the server's to
 * decide - the amount comes from the appointment, and recording a counter
 * payment is what makes it COMPLETED. Accepting either from the client is the
 * hole this module used to have.
 */
const createPaymentValidation = z.object({
  body: z.object({
    appointmentId: z
      .string()
      .nonempty({ message: "Appointment ID is required" }),
    paymentMethod: z.enum(["CASH", "CARD", "MOBILE_BANKING"]),
  }),
});

const updatePaymentStatusValidation = z.object({
  body: z.object({
    status: z.enum(["PENDING", "COMPLETED", "FAILED", "REFUNDED"]),
  }),
});

// No amount refunds whatever is left of the top-up.
const refundTopupValidation = z.object({
  body: z.object({
    amount: takaAmount
      .refine((value) => value > 0, { message: "Refund amount must be positive" })
      .optional(),
    reason: z.string().trim().min(3).max(255),
  }),
});

export const PaymentValidation = {
  createPaymentValidation,
  updatePaymentStatusValidation,
  refundTopupValidation,
};
