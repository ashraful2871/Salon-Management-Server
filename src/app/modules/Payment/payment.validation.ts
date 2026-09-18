import { z } from "zod";

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

export const PaymentValidation = {
  createPaymentValidation,
  updatePaymentStatusValidation,
};
