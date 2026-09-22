import { z } from "zod";
import { BD_BOUNDS } from "../Salon/salon.validation";

// The bias is only a ranking hint - the bbox and country filter already keep
// results inside Bangladesh - so a caller elsewhere in the world is accepted.
const searchQuery = z
  .object({
    q: z
      .string()
      .trim()
      .min(2, "Type at least 2 characters")
      .max(100, "Search text is too long"),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    limit: z.coerce.number().int().min(1).max(10).default(5),
  })
  .refine((q) => (q.lat === undefined) === (q.lng === undefined), {
    message: "lat and lng must be sent together",
    path: ["lat"],
  });

const reverseQuery = z.object({
  lat: z.coerce
    .number()
    .min(BD_BOUNDS.minLat, "Location must be inside Bangladesh")
    .max(BD_BOUNDS.maxLat, "Location must be inside Bangladesh"),
  lng: z.coerce
    .number()
    .min(BD_BOUNDS.minLng, "Location must be inside Bangladesh")
    .max(BD_BOUNDS.maxLng, "Location must be inside Bangladesh"),
});

export type GeoSearchQuery = z.infer<typeof searchQuery>;
export type GeoReverseQuery = z.infer<typeof reverseQuery>;

export const GeoValidation = { searchQuery, reverseQuery };
