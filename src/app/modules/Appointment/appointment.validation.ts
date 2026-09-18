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

const updateAppointmentStatusValidation = z.object({
  body: z.object({
    status: z.enum([
      "PENDING",
      "CONFIRMED",
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

export const AppointmentValidation = {
  bookAppointmentValidation,
  updateAppointmentStatusValidation,
  appealNoShowValidation,
  resolveAppealValidation,
};
