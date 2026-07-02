import { z } from "zod";

const createAgentSchema = z.object({
  body: z.object({
    name: z.string({
      required_error: "Name is required",
    }),
    email: z
      .string({
        required_error: "Email is required",
      })
      .email(),
    password: z
      .string({
        required_error: "Password is required",
      })
      .min(6, "Password must be at least 6 characters"),
    division: z.string({
      required_error: "Division is required",
    }),
    district: z.string({
      required_error: "District is required",
    }),
    area: z.string({
      required_error: "Area is required",
    }),
    phone: z.string().optional(),
    gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
  }),
});

export const AgentValidation = {
  createAgentSchema,
};
