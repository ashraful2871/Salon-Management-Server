import { z } from "zod";

const applySalonOwnerValidation = z.object({
  body: z.object({
    businessName: z.string().min(2).optional(),
    businessAddress: z.string().min(5).optional(),
    businessPhone: z.string().min(6).optional(),
    businessEmail: z.string().email().optional(),
    documentUrl: z.string().url().optional(),
  }),
});

const approveSalonOwnerValidation = z.object({
  body: z.object({}).optional(),
});

const rejectSalonOwnerValidation = z.object({
  body: z.object({
    rejectionReason: z
      .string()
      .min(5, "Rejection reason must be at least 5 characters"),
  }),
});

export const SalonOwnerValidation = {
  applySalonOwnerValidation,
  approveSalonOwnerValidation,
  rejectSalonOwnerValidation,
};
