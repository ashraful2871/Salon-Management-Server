import { z } from "zod";

const bookAppointmentValidation = z.object({
  body: z.object({
    salonId: z.string().nonempty({ message: "Salon ID is required" }),
    serviceId: z.string().nonempty({ message: "Service ID is required" }),
    staffId: z.string().nonempty({ message: "Staff ID is required" }),
    counterId: z.string().nonempty({ message: "Counter ID is required" }),
    appointmentDate: z
      .string()
      .nonempty({ message: "Appointment date is required" }),
    startTime: z.string().nonempty({ message: "Start time is required" }),
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
  }),
});

export const AppointmentValidation = {
  bookAppointmentValidation,
  updateAppointmentStatusValidation,
};
