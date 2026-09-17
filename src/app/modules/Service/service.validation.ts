import { z } from "zod";

const createServiceValidation = z.object({
  body: z.object({
    name: z.string().nonempty({ message: "Service name is required" }),
    description: z.string().optional(),
    category: z.enum([
      "HAIRCUT",
      "STYLING",
      "COLORING",
      "TREATMENT",
      "SPA",
      "FACIAL",
      "MANICURE",
      "PEDICURE",
      "MAKEUP",
      "WAXING",
      "MASSAGE",
      "OTHER",
    ]),
    price: z
      .number()
      .refine((val) => val > 0, {
        message: "Price is required and must be positive",
      })
      // Stored as integer poisha, so anything finer would be silently rounded.
      .refine((val) => Math.abs(val * 100 - Math.round(val * 100)) < 1e-9, {
        message: "Price cannot be smaller than one poisha (0.01)",
      }),
    duration: z.number().refine((val) => val > 0, {
      message: "Duration is required and must be positive",
    }),
    salonId: z.string().nonempty({ message: "Salon ID is required" }),
    images: z.array(z.string()).optional(),
  }),
});

const updateServiceValidation = z.object({
  body: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    category: z
      .enum([
        "HAIRCUT",
        "STYLING",
        "COLORING",
        "TREATMENT",
        "SPA",
        "FACIAL",
        "MANICURE",
        "PEDICURE",
        "MAKEUP",
        "WAXING",
        "MASSAGE",
        "OTHER",
      ])
      .optional(),
    price: z
      .number()
      .positive()
      .refine((val) => Math.abs(val * 100 - Math.round(val * 100)) < 1e-9, {
        message: "Price cannot be smaller than one poisha (0.01)",
      })
      .optional(),
    duration: z.number().positive().optional(),
    images: z.array(z.string()).optional(),
    isActive: z.boolean().optional(),
  }),
});

export const ServiceValidation = {
  createServiceValidation,
  updateServiceValidation,
};
