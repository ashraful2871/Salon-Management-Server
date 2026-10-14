import { z } from "zod";
import { REPORT_REASONS } from "./review.service";

const report = z.object({
  body: z.object({
    reason: z.enum(REPORT_REASONS),
    note: z.string().trim().max(500).optional(),
  }),
});

const reply = z.object({
  body: z.object({
    text: z.string().trim().min(1, "Write a reply").max(1000),
  }),
});

export const ReviewValidation = { report, reply };
