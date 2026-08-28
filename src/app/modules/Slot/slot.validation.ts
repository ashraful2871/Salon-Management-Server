import { z } from "zod";

const bulkCreateSlotsValidation = z.object({
  body: z.object({
    salonId: z.string().nonempty({ message: "Salon ID is required" }),
    date: z.string().nonempty({ message: "Date is required" }),
    startTime: z.string().nonempty({ message: "Start time is required" }),
    endTime: z.string().nonempty({ message: "End time is required" }),
    duration: z.number().positive({ message: "Duration must be positive" }),
    breakDuration: z.number().min(0).default(0),
  }),
});

const updateSlotStatusValidation = z.object({
  body: z.object({
    status: z.enum(["AVAILABLE", "BLOCKED", "CANCELLED", "COMPLETED", "BOOKED"]),
  }),
});

export const SlotValidation = {
  bulkCreateSlotsValidation,
  updateSlotStatusValidation,
};
