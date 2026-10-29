import { HomeAudience, HomeCategory } from "@prisma/client";
import { z } from "zod";

/**
 * Request shapes for Home Service. Bounds that come from platform settings
 * (radius, travel fee, min order, day bounds) are checked in the service,
 * since they change at runtime; only the fixed ones live here.
 */

const salonId = z.string().uuid();
const reason = z.string().trim().max(300).optional();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24 h)");

const salonQuery = z.object({ query: z.object({ salonId }).passthrough() });

const idParams = z.object({ id: z.string().uuid() });

// ---------------------------------------------------------------- profile

const turnOn = z.object({
  body: z
    .object({ salonId, ladies: z.boolean(), gents: z.boolean(), reason })
    .refine((b) => b.ladies || b.gents, { message: "Pick Ladies, Gents or both", path: ["ladies"] }),
});

const turnOff = z.object({
  body: z.object({ salonId, upcoming: z.enum(["KEEP", "CANCEL"]), reason }),
});

const pause = z.object({
  body: z.object({ salonId, until: z.coerce.date().optional(), reason }),
});

const resume = z.object({ body: z.object({ salonId, reason }) });

const updateProfile = z.object({
  body: z.object({
    salonId,
    radiusKm: z.number().min(0.5).optional(),
    travelFeeMinor: z.number().int().min(0).optional(),
    minOrderMinor: z.number().int().min(0).optional(),
    travelBufferMin: z.number().int().min(15).max(90).optional(),
    dayStart: hhmm.optional(),
    dayEnd: hhmm.optional(),
  }),
});

// ---------------------------------------------------------------- offerings

const offeringFields = {
  category: z.nativeEnum(HomeCategory),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).nullable().optional(),
  kitNote: z.string().trim().max(200).nullable().optional(),
  durationMin: z
    .number()
    .int()
    .min(15)
    .max(480)
    .refine((n) => n % 15 === 0, "Duration must be a multiple of 15 minutes"),
  priceMinor: z.number().int().min(1_000).max(10_000_000),
  images: z.array(z.string().url()).max(5),
  sortOrder: z.number().int().min(0).max(10_000),
};

const listOfferings = z.object({
  query: z.object({ salonId, audience: z.nativeEnum(HomeAudience).optional() }).passthrough(),
});

const createOffering = z.object({
  body: z.object({
    salonId,
    audience: z.nativeEnum(HomeAudience),
    ...offeringFields,
    images: offeringFields.images.default([]),
    sortOrder: offeringFields.sortOrder.default(0),
    isActive: z.boolean().default(true),
  }),
});

// The audience is fixed once created: experts are linked by gender to it.
const updateOffering = z.object({
  params: idParams,
  body: z
    .object({
      category: offeringFields.category.optional(),
      name: offeringFields.name.optional(),
      description: offeringFields.description,
      kitNote: offeringFields.kitNote,
      durationMin: offeringFields.durationMin.optional(),
      priceMinor: offeringFields.priceMinor.optional(),
      images: offeringFields.images.optional(),
      sortOrder: offeringFields.sortOrder.optional(),
    })
    .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "Nothing to change" }),
});

const offeringId = z.object({ params: idParams });

// ---------------------------------------------------------------- experts

const expertGender = z.enum(["MALE", "FEMALE"], { error: "Home experts must be registered as female or male" });
const docKind = z.enum(["ID_FRONT", "ID_BACK", "SELFIE"]);
const requiredReason = z.string().trim().min(3).max(300);

const createExpert = z.object({
  body: z.object({ salonId, staffId: z.string().uuid(), gender: expertGender }),
});

const updateExpert = z.object({
  params: idParams,
  body: z
    .object({
      headline: z.string().trim().max(80).nullable().optional(),
      languages: z.array(z.string().trim().min(2).max(30)).max(5).optional(),
      maxJobsPerDay: z.number().int().min(1).max(8).optional(),
      isActive: z.boolean().optional(),
      gender: expertGender.optional(),
    })
    .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "Nothing to change" }),
});

const expertOfferings = z.object({
  params: idParams,
  body: z.object({ offeringIds: z.array(z.string().uuid()).max(100) }),
});

const docSignature = z.object({ params: idParams, body: z.object({ kind: docKind }) });

const expertDoc = z.object({
  params: idParams,
  body: z.object({
    kind: docKind,
    publicId: z.string().trim().min(1).max(255),
    bytes: z.number().int().min(1).max(8 * 1024 * 1024, "Documents must be at most 8 MB"),
  }),
});

const expertId = z.object({ params: idParams });

const removeExpert = z.object({ params: idParams, body: z.object({ reason }).optional() });

// ---------------------------------------------------------------- admin

const page = z.coerce.number().int().min(1).max(10_000).optional();

const adminProfiles = z.object({
  query: z
    .object({ status: z.enum(["PENDING_REVIEW", "ACTIVE", "SUSPENDED", "REJECTED"]).optional(), page })
    .passthrough(),
});

const adminExperts = z.object({
  query: z
    .object({ verification: z.enum(["DRAFT", "PENDING", "VERIFIED", "REJECTED", "SUSPENDED"]).optional(), page })
    .passthrough(),
});

const adminWithReason = z.object({ params: idParams, body: z.object({ reason: requiredReason }) });
const adminOptionalReason = z.object({ params: idParams, body: z.object({ reason }).optional().default({}) });

const adminExpertGender = z.object({
  params: idParams,
  body: z.object({ gender: expertGender, reason: requiredReason }),
});

export const HomeValidation = {
  salonQuery,
  turnOn,
  turnOff,
  pause,
  resume,
  updateProfile,
  listOfferings,
  createOffering,
  updateOffering,
  offeringId,
  createExpert,
  updateExpert,
  expertOfferings,
  docSignature,
  expertDoc,
  expertId,
  removeExpert,
  adminProfiles,
  adminExperts,
  adminWithReason,
  adminOptionalReason,
  adminExpertGender,
};

export type DocKind = z.infer<typeof docKind>;
export type CreateExpertBody = z.infer<typeof createExpert>["body"];
export type UpdateExpertBody = z.infer<typeof updateExpert>["body"];
export type ExpertDocBody = z.infer<typeof expertDoc>["body"];

export type TurnOnBody = z.infer<typeof turnOn>["body"];
export type TurnOffBody = z.infer<typeof turnOff>["body"];
export type PauseBody = z.infer<typeof pause>["body"];
export type ResumeBody = z.infer<typeof resume>["body"];
export type UpdateProfileBody = z.infer<typeof updateProfile>["body"];
export type CreateOfferingBody = z.infer<typeof createOffering>["body"];
export type UpdateOfferingBody = z.infer<typeof updateOffering>["body"];
