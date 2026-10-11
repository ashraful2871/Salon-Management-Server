import { z } from "zod";

/** The value is checked against the key's own schema in the service. */
const update = z.object({
  body: z
    .object({
      value: z.unknown(),
      reason: z.string().trim().min(3, "Say why (at least 3 characters)").max(500),
    })
    .refine((b) => b.value !== undefined, {
      message: "A value is required",
      path: ["value"],
    }),
});

export const AdminSettingsValidation = { update };
