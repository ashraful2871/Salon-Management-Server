import { HomeAudience, HomeCategory, HomeReportStatus, HomeSafetyKind } from "@prisma/client";
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

// ---------------------------------------------------------------- booking (customer)
// Types and coarse caps only: the field-length, location and recipient rules
// run in the booking checks, in their documented order and with their codes.

const loose = (max: number) => z.string().max(max);

const quoteFields = {
  salonId,
  audience: z.nativeEnum(HomeAudience),
  offeringIds: z.array(z.string().uuid()).min(1).max(10),
  expertId: z.union([z.literal("ANY"), z.string().uuid()]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  startAt: z.string().datetime({ offset: true }),
  lat: z.number(),
  lng: z.number(),
  addressLine: loose(1000),
  area: loose(1000).optional(),
  landmark: loose(1000).optional(),
  recipientName: loose(1000),
  recipientIsWoman: z.boolean().optional(),
  contactPhone: loose(40),
  notes: loose(2000).optional(),
};

const quote = z.object({ body: z.object(quoteFields) });

const createBooking = z.object({
  body: z.object({
    ...quoteFields,
    quoteHash: z.string().regex(/^[0-9a-f]{64}$/),
    policyAccepted: z.boolean().default(false),
    policyVersion: z.number().int().min(0),
    lang: z.enum(["en", "bn"]).optional(),
  }),
});

const payBooking = z.object({
  params: idParams,
  body: z.object({ method: z.enum(["WALLET", "BKASH", "SSLCOMMERZ"]) }),
});

const myBookings = z.object({
  query: z.object({ tab: z.enum(["upcoming", "past"]).optional(), page }).passthrough(),
});

const bookingId = z.object({ params: idParams });

// ---------------------------------------------------------------- visit lifecycle

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const myJobs = z.object({ query: z.object({ date: day.optional() }).passthrough() });

const startJob = z.object({ params: idParams, body: z.object({ code: z.string().regex(/^\d{4}$/, "Enter the 4-digit code") }) });

const completeJob = z.object({
  params: idParams,
  body: z.object({
    balanceMethod: z.enum(["CASH", "BKASH_TO_SALON", "WALLET", "NOT_COLLECTED"]),
    collectedMinor: z.number().int().min(0).max(10_000_000),
    note: z.string().trim().max(500).optional(),
  }),
});

const ownerBookingsQuery = z
  .object({
    salonId: salonId.optional(),
    tab: z.enum(["today", "upcoming", "past"]).optional(),
    status: z.enum(["PENDING_PAYMENT", "CONFIRMED", "EN_ROUTE", "ARRIVED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "NO_SHOW", "EXPIRED"]).optional(),
    audience: z.nativeEnum(HomeAudience).optional(),
    expertId: z.string().uuid().optional(),
    from: day.optional(),
    to: day.optional(),
    page,
  })
  .passthrough();

const ownerBookings = z.object({ query: ownerBookingsQuery });

const reassign = z.object({ params: idParams, body: z.object({ expertId: z.string().uuid(), reason: requiredReason }) });

const overrideStart = z.object({ params: idParams, body: z.object({ reason: requiredReason }) });

// ---------------------------------------------------------------- ends, reschedule, appeals

const customerCancel = z.object({ params: idParams, body: z.object({ reason }).optional().default({}) });

const reschedule = z.object({
  params: idParams,
  body: z.object({
    date: day,
    startAt: z.string().datetime({ offset: true }),
    /** Omitted = the same expert; "ANY" = any free expert of the branch. */
    expertId: z.union([z.literal("ANY"), z.string().uuid()]).optional(),
  }),
});

const appeal = z.object({ params: idParams, body: z.object({ reason: z.string().trim().min(3).max(1000) }) });

const jobAbort = z.object({ params: idParams, body: z.object({ kind: z.enum(["MISMATCH", "SAFETY"]), reason: requiredReason }) });

const withReason = z.object({ params: idParams, body: z.object({ reason: requiredReason }) });

const adminCancel = z.object({ params: idParams, body: z.object({ reason: requiredReason, salonAtFault: z.boolean() }) });

const adminResolveAppeal = z.object({
  params: idParams,
  body: z.object({ approve: z.boolean(), note: z.string().trim().max(1000).optional() }),
});

// ---------------------------------------------------------------- safety, reviews

const safetyReport = z.object({
  params: idParams,
  body: z.object({
    kind: z.nativeEnum(HomeSafetyKind),
    details: z.string().trim().min(10, "Tell us a little more (10 characters or more)").max(2000),
  }),
});

const adminReports = z.object({
  query: z
    .object({ status: z.nativeEnum(HomeReportStatus).optional(), page: z.coerce.number().int().min(1).optional() })
    .passthrough(),
});

const adminReportStatus = z.object({
  params: idParams,
  body: z.object({
    status: z.nativeEnum(HomeReportStatus),
    note: z.string().trim().min(3).max(1000),
    blockCustomer: z.object({ days: z.number().int().min(1).max(365) }).optional(),
  }),
});

const createReview = z.object({
  params: idParams,
  body: z.object({
    rating: z.number().int().min(1).max(5),
    comment: z.string().trim().max(1000).optional(),
  }),
});

const expertReviews = z.object({
  params: idParams,
  query: z.object({ page: z.coerce.number().int().min(1).optional() }).passthrough(),
});

// ---------------------------------------------------------------- saved addresses
// The same lengths the booking checks apply to a visit's address.

const addressFields = {
  label: z.string().trim().min(1).max(30),
  addressLine: z.string().trim().min(5).max(200),
  area: z.string().trim().max(80).nullable().optional(),
  landmark: z.string().trim().max(120).nullable().optional(),
  latitude: z.number().finite(),
  longitude: z.number().finite(),
  isDefault: z.boolean().optional(),
};

const createAddress = z.object({ body: z.object(addressFields) });

const updateAddress = z.object({
  params: idParams,
  body: z
    .object({
      label: addressFields.label.optional(),
      addressLine: addressFields.addressLine.optional(),
      area: addressFields.area,
      landmark: addressFields.landmark,
      latitude: addressFields.latitude.optional(),
      longitude: addressFields.longitude.optional(),
      isDefault: addressFields.isDefault,
    })
    .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "Nothing to change" })
    .refine((b) => (b.latitude === undefined) === (b.longitude === undefined), { message: "Send latitude and longitude together" }),
});

// ---------------------------------------------------------------- admin bookings explorer

const adminBookings = z.object({
  query: z
    .object({
      status: ownerBookingsQuery.shape.status,
      audience: z.nativeEnum(HomeAudience).optional(),
      salonId: salonId.optional(),
      q: z.string().trim().max(100).optional(),
      from: day.optional(),
      to: day.optional(),
      page,
    })
    .passthrough(),
});

export const HomeValidation = {
  createAddress,
  updateAddress,
  adminBookings,
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
  quote,
  createBooking,
  payBooking,
  myBookings,
  bookingId,
  myJobs,
  startJob,
  completeJob,
  ownerBookings,
  reassign,
  overrideStart,
  customerCancel,
  reschedule,
  appeal,
  jobAbort,
  withReason,
  adminCancel,
  adminResolveAppeal,
  safetyReport,
  adminReports,
  adminReportStatus,
  createReview,
  expertReviews,
};

export type AddressBody = z.infer<typeof createAddress>["body"];
export type AdminBookingsQuery = z.infer<typeof adminBookings>["query"];
export type RescheduleBody =z.infer<typeof reschedule>["body"];
export type CompleteJobBody = z.infer<typeof completeJob>["body"];
export type OwnerBookingsQuery = z.infer<typeof ownerBookingsQuery>;

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
export type QuoteBody = z.infer<typeof quote>["body"];
export type CreateBookingBody = z.infer<typeof createBooking>["body"];
export type SafetyReportBody = z.infer<typeof safetyReport>["body"];
export type AdminReportStatusBody = z.infer<typeof adminReportStatus>["body"];
export type CreateReviewBody = z.infer<typeof createReview>["body"];
