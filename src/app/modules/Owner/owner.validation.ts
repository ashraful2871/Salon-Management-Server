import { z } from "zod";

/** `?salonId=` on owner pages: one branch, or every branch when absent. */
const branchQuery = z.object({
  query: z.object({
    salonId: z.string().trim().min(1).optional(),
  }),
});

export const OwnerValidation = {
  branchQuery,
};
