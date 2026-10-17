import { z } from "zod";

const addStaffValidation = z.object({
  body: z.object({
    email: z.string().trim().toLowerCase().email("Enter a valid email address"),
    name: z.string().trim().min(1).max(100).optional(),
    salonId: z.string().nonempty({ message: "Salon ID is required" }),
    speciality: z.string().optional(),
    experience: z.number().optional(),
    bio: z.string().optional(),
    serviceIds: z.array(z.string()).optional(),
  }),
});

const updateStaffValidation = z.object({
  body: z.object({
    speciality: z.string().optional(),
    experience: z.number().optional(),
    bio: z.string().optional(),
    status: z.enum(["AVAILABLE", "BUSY", "ON_LEAVE", "INACTIVE"]).optional(),
    serviceIds: z.array(z.string()).optional(),
  }),
});

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

const shift = z
  .object({
    weekday: z.number().int().min(0).max(6),
    startTime: z.string().regex(HHMM, "Use HH:mm"),
    endTime: z.string().regex(HHMM, "Use HH:mm"),
  })
  .refine((s) => s.startTime < s.endTime, { message: "A shift must end after it starts" });

const putShiftsValidation = z.object({
  body: z.object({ shifts: z.array(shift).max(21) }),
});

const addTimeOffValidation = z.object({
  body: z.object({
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    reason: z.string().trim().max(200).optional(),
  }),
});

const availabilityValidation = z.object({
  query: z.object({ appointmentId: z.string().uuid() }),
});

export const StaffValidation = {
  addStaffValidation,
  updateStaffValidation,
  putShiftsValidation,
  addTimeOffValidation,
  availabilityValidation,
};
