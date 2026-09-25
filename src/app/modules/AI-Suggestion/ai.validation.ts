import { z } from "zod";
import { BD_BOUNDS } from "../Salon/salon.validation";

// lat/lng are the customer's saved location (the frontend's sm_loc cookie),
// already rounded to ~110 m. Outside Bangladesh they are rejected rather than
// ranking every salon as hundreds of km away.
const searchBody = z
  .object({
    prompt: z
      .string()
      .trim()
      .min(2, "Tell us what you are looking for")
      .max(300, "Please keep it under 300 characters"),
    limit: z.coerce.number().int().min(1).max(12).optional(),
    lat: z.coerce.number().min(BD_BOUNDS.minLat).max(BD_BOUNDS.maxLat).optional(),
    lng: z.coerce.number().min(BD_BOUNDS.minLng).max(BD_BOUNDS.maxLng).optional(),
    locationLabel: z.string().trim().max(80).optional(),
  })
  .refine((b) => (b.lat === undefined) === (b.lng === undefined), {
    message: "lat and lng must be sent together",
    path: ["lat"],
  });

const searchValidation = z.object({ body: searchBody });

export type AiSearchBody = z.infer<typeof searchBody>;

export const AiValidation = { searchBody, searchValidation };
