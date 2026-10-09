import { z } from "zod";
import { REPORT_REASONS } from "./review.service";

const report = z.object({
  body: z.object({
    reason: z.enum(REPORT_REASONS),
    note: z.string().trim().max(500).optional(),
  }),
});

export const ReviewValidation = { report };
