import { z } from "zod";

// Bangladesh bounding box. The lat and lng ranges don't overlap, so a swapped
// pair always fails validation instead of landing a pin in the Bay of Bengal.
export const BD_BOUNDS = {
  minLat: 20.3,
  maxLat: 26.8,
  minLng: 87.9,
  maxLng: 92.8,
} as const;

const latitude = z
  .number()
  .min(BD_BOUNDS.minLat, "Location must be inside Bangladesh")
  .max(BD_BOUNDS.maxLat, "Location must be inside Bangladesh");
const longitude = z
  .number()
  .min(BD_BOUNDS.minLng, "Location must be inside Bangladesh")
  .max(BD_BOUNDS.maxLng, "Location must be inside Bangladesh");

// The DB CHECK salons_coords_pair_chk rejects half a pin; fail early with a 400.
const coordsPair = (b: { latitude?: number; longitude?: number }) =>
  (b.latitude === undefined) === (b.longitude === undefined);

const coordsPairError = {
  message: "Send latitude and longitude together",
  path: ["latitude"],
};

const createSalonValidation = z.object({
  body: z.object({
    name: z.string().nonempty({ message: "Salon name is required" }),
    description: z.string().optional(),
    website: z.string().optional(),
    address: z.string().nonempty({ message: "Address is required" }),
    division: z.string().nonempty({ message: "Division is required" }),
    district: z.string().nonempty({ message: "District is required" }),
    area: z.string().nonempty({ message: "Area is required" }),
    city: z.string().nonempty({ message: "City is required" }),
    state: z.string().optional(),
    zipCode: z.string().optional(),
    phone: z.string().nonempty({ message: "Phone is required" }),
    email: z.string().email().optional(),
    images: z.array(z.string()).optional(),
    operatingHours: z.any().optional(),
    latitude: latitude.optional(),
    longitude: longitude.optional(),
  }).refine(coordsPair, coordsPairError),
});

const updateSalonValidation = z.object({
  body: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    website: z.string().optional(),
    address: z.string().optional(),
    division: z.string().optional(),
    district: z.string().optional(),
    area: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    zipCode: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    images: z.array(z.string()).optional(),
    operatingHours: z.any().optional(),
    latitude: latitude.optional(),
    longitude: longitude.optional(),
  }).refine(coordsPair, coordsPairError),
});

// Owner moves the pin. Both coordinates required.
const updateSalonLocationValidation = z.object({
  body: z.object({
    latitude,
    longitude,
  }),
});

const updateSalonStatusValidation = z.object({
  body: z.object({
    status: z.enum(["ACTIVE", "INACTIVE", "PENDING_APPROVAL", "REJECTED"]),
  }),
});

// Query schemas below are parsed in the controller, not through
// validateRequest: it doesn't write coerced values back to req.query.
const salonListQuery = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(10),
    searchTerm: z.string().trim().max(100).optional(),
    city: z.string().trim().max(60).optional(),
    division: z.string().trim().max(60).optional(),
    district: z.string().trim().max(60).optional(),
    area: z.string().trim().max(60).optional(),
    status: z
      .enum(["ACTIVE", "INACTIVE", "PENDING_APPROVAL", "REJECTED"])
      .optional(),
    lat: z.coerce
      .number()
      .min(BD_BOUNDS.minLat)
      .max(BD_BOUNDS.maxLat)
      .optional(),
    lng: z.coerce
      .number()
      .min(BD_BOUNDS.minLng)
      .max(BD_BOUNDS.maxLng)
      .optional(),
    radiusKm: z.coerce.number().min(0.5).max(50).default(5),
    sort: z.enum(["distance", "rating", "newest"]).optional(),
  })
  .refine((q) => (q.lat === undefined) === (q.lng === undefined), {
    message: "lat and lng must be sent together",
    path: ["lat"],
  })
  .refine((q) => q.sort !== "distance" || q.lat !== undefined, {
    message: "sort=distance needs lat and lng",
    path: ["sort"],
  });

export type SalonListQuery = z.infer<typeof salonListQuery>;

const salonMapQuery = z
  .object({
    bbox: z
      .string()
      .transform((s) => s.split(",").map(Number))
      .pipe(z.tuple([z.number(), z.number(), z.number(), z.number()])),
  })
  .refine(
    ({ bbox: [minLng, minLat, maxLng, maxLat] }) =>
      minLng < maxLng &&
      minLat < maxLat &&
      maxLng - minLng <= 1.5 &&
      maxLat - minLat <= 1.5,
    {
      message: "bbox must be minLng,minLat,maxLng,maxLat and at most 1.5° wide",
      path: ["bbox"],
    },
  );

export const SalonValidation = {
  createSalonValidation,
  updateSalonValidation,
  updateSalonStatusValidation,
  updateSalonLocationValidation,
  salonListQuery,
  salonMapQuery,
};
