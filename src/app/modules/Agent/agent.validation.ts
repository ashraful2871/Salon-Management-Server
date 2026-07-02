import { z } from "zod";

const createAgentSchema = z.object({
  body: z.object({
    name: z.string({
      message: "Name is required",
    }),
    email: z
      .string({
        message: "Email is required",
      })
      .email(),
    password: z
      .string({
        message: "Password is required",
      })
      .min(6, "Password must be at least 6 characters"),
    division: z.string({
      message: "Division is required",
    }),
    district: z.string({
      message: "District is required",
    }),
    area: z.string({
      message: "Area is required",
    }),
    phone: z.string().optional(),
    gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
  }),
});

export const AgentValidation = {
  createAgentSchema,
};
