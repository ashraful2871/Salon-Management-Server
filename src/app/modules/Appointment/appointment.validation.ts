import { z } from "zod";

const bookAppointmentValidation = z.object({
  body: z.object({
    salonId: z.string().nonempty({ message: "Salon ID is required" }),
    serviceId: z.string().nonempty({ message: "Service ID is required" }),
    staffId: z.string().optional(),
    counterId: z.string().nonempty({ message: "Counter ID is required" }),
    slotId: z.string().nonempty({ message: "Slot ID is required" }),
    notes: z.string().optional(),
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
  body: z.object({
    paymentMethod: z.enum(["CASH", "CARD", "MOBILE_BANKING"]),
    reference: z.string().max(100).optional(),
  }),
});

export const AppointmentValidation = {
  bookAppointmentValidation,
  walkInValidation,
  updateAppointmentStatusValidation,
  appealNoShowValidation,
  resolveAppealValidation,
  lookupByTokenValidation,
  cashSummaryValidation,
  checkoutValidation,
};
