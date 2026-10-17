import { z } from "zod";

const bookAppointmentValidation = z.object({
  body: z.object({
    salonId: z.string().nonempty({ message: "Salon ID is required" }),
    serviceId: z.string().nonempty({ message: "Service ID is required" }),
    staffId: z.string().optional(),
    counterId: z.string().nonempty({ message: "Counter ID is required" }),
    slotId: z.string().nonempty({ message: "Slot ID is required" }),
    notes: z.string().optional(),
    /** Pay the whole bill from the wallet now (owner Phase 15). */
    payInFull: z.boolean().optional(),
  }),
});

const walkInValidation = z.object({
  body: z.object({
    slotId: z.string().nonempty({ message: "Slot ID is required" }),
    customerName: z
      .string()
      .trim()
      .nonempty({ message: "Customer name is required" })
      .max(100),
    customerPhone: z
      .string()
      .trim()
      .regex(/^\+?[\d\s-]+$/, { message: "Enter a valid phone number" })
      .refine(
        (phone) => {
          const digits = phone.replace(/\D/g, "").length;
          return digits >= 6 && digits <= 15;
        },
        { message: "Enter a valid phone number" },
      ),
    notes: z.string().max(1000).optional(),
    staffId: z.string().uuid().optional(),
  }),
});

const updateAppointmentStatusValidation = z.object({
  body: z.object({
    status: z.enum([
      "PENDING",
      "CONFIRMED",
      "CHECKED_IN",
      "IN_PROGRESS",
      "COMPLETED",
      "CANCELLED",
      "NO_SHOW",
    ]),
    cancellationReason: z.string().optional(),
    staffId: z.string().optional(),
  }),
});

const appealNoShowValidation = z.object({
  body: z.object({
    reason: z
      .string()
      .trim()
      .nonempty({ message: "Tell us what happened" })
      .max(1000),
  }),
});

const resolveAppealValidation = z.object({
  body: z.object({
    approve: z.boolean(),
    note: z.string().max(1000).optional(),
    reason: z.string().trim().max(500).optional(),
  }),
});

const lookupByTokenValidation = z.object({
  query: z.object({
    token: z.string().trim().nonempty({ message: "Token is required" }),
  }),
});

const cashSummaryValidation = z.object({
  query: z.object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "date must be YYYY-MM-DD" }),
    salonId: z.string().optional(),
  }),
});

const checkoutValidation = z.object({
  body: z
    .object({
      paymentMethod: z.enum(["CASH", "CARD", "MOBILE_BANKING"]),
      reference: z.string().max(100).optional(),
      // Poisha. The tip is the salon's own money: in the till, never commissioned.
      tipMinor: z.number().int().min(0).max(10_000_000).optional(),
      // Comes off the bill; the upper bound (total less the deposit) is checked
      // against the booking in the service.
      discountMinor: z.number().int().min(0).optional(),
      discountReason: z.string().trim().max(200).optional(),
    })
    .refine((b) => !b.discountMinor || (b.discountReason ?? "").length >= 3, {
      message: "Give a reason for the discount",
      path: ["discountReason"],
    }),
});

const rescheduleValidation = z.object({
  body: z.object({
    slotId: z.string().uuid({ message: "Pick a time to move the booking to" }),
  }),
});

/** A salon refund of a completed booking, to the customer's wallet (owner Phase 15). */
const refundValidation = z.object({
  body: z.object({
    amountMinor: z.number().int().min(1, "Refund at least ৳0.01"),
    reason: z.string().trim().min(3, "Give a reason for the refund").max(200),
  }),
});

export const AppointmentValidation = {
  refundValidation,
  bookAppointmentValidation,
  walkInValidation,
  updateAppointmentStatusValidation,
  appealNoShowValidation,
  resolveAppealValidation,
  lookupByTokenValidation,
  cashSummaryValidation,
  checkoutValidation,
  rescheduleValidation,
};
