import { z } from "zod";
import { BD_BOUNDS } from "../../Salon/salon.validation";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const bool = z.enum(["true", "false"]);

/** Why a salon was rejected, suspended or set inactive. OTHER needs a note. */
export const SALON_REASON_CODES = [
  "INCOMPLETE_DETAILS",
  "WRONG_LOCATION",
  "DUPLICATE",
  "NOT_A_SALON",
  "POLICY",
  "OTHER",
] as const;
export type SalonReasonCode = (typeof SALON_REASON_CODES)[number];

export const SALON_REASON_LABELS: Record<SalonReasonCode, string> = {
  INCOMPLETE_DETAILS: "Details are incomplete",
  WRONG_LOCATION: "The map pin or address is wrong",
  DUPLICATE: "This salon is already listed",
  NOT_A_SALON: "This is not a salon",
  POLICY: "Breach of our terms",
  OTHER: "Other",
};

/** The owner-facing "what to fix" line in a rejection email. */
export const SALON_REASON_FIX: Partial<Record<SalonReasonCode, string>> = {
  INCOMPLETE_DETAILS:
    "Add the address, phone, opening hours, at least one photo and at least one priced service.",
  WRONG_LOCATION: "Open the Location tab and drag the pin onto your salon's door.",
  DUPLICATE: "If this is a second branch, give it its own name and address.",
};

export const ADMIN_SALON_STATUSES = ["ACTIVE", "REJECTED", "SUSPENDED", "INACTIVE"] as const;

const note = z.string().trim().max(500).optional();
const reason = z.string().trim().min(3, "Give a reason").max(500);

const list = z.object({
  query: z.object({
    q: z.string().max(100).optional(),
    status: z.enum(["ACTIVE", "INACTIVE", "PENDING_APPROVAL", "REJECTED", "SUSPENDED"]).optional(),
    division: z.string().max(60).optional(),
    district: z.string().max(60).optional(),
    area: z.string().max(60).optional(),
    location: z.enum(["EXACT", "APPROXIMATE", "NONE"]).optional(),
    minRating: z.string().regex(/^\d(\.\d+)?$/).optional(),
    from: ymd.optional(),
    to: ymd.optional(),
    includeTest: bool.optional(),
    sort: z.string().max(40).optional(),
    page: z.string().optional(),
    limit: z.string().optional(),
  }),
});

/**
 * Shared by `PATCH /admin/salons/:id/status` and the older
 * `PATCH /salons/:id/status`. `reason` is the older free-text field and is
 * read as an OTHER note.
 */
const updateStatus = z.object({
  body: z
    .object({
      status: z.enum(ADMIN_SALON_STATUSES),
      reasonCode: z.enum(SALON_REASON_CODES).optional(),
      note,
      reason: note,
      notify: z.boolean().default(true),
    })
    .transform(({ reason: legacy, ...b }) =>
      !b.reasonCode && legacy ? { ...b, reasonCode: "OTHER" as const, note: b.note ?? legacy } : b,
    )
    .refine((b) => b.status === "ACTIVE" || !!b.reasonCode, {
      message: "Pick a reason",
      path: ["reasonCode"],
    })
    .refine((b) => b.reasonCode !== "OTHER" || !!b.note, {
      message: "Add a note when the reason is Other",
      path: ["note"],
    }),
});

const withReason = z.object({ body: z.object({ reason }) });

const optionalReason = z.object({ body: z.object({ reason: reason.optional() }).default({}) });

const updateLocation = z.object({
  body: z.object({
    latitude: z.number().min(BD_BOUNDS.minLat).max(BD_BOUNDS.maxLat),
    longitude: z.number().min(BD_BOUNDS.minLng).max(BD_BOUNDS.maxLng),
    reason: reason.optional(),
  }),
});

const updateListing = z.object({
  body: z
    .object({
      name: z.string().trim().min(2).max(120).optional(),
      description: z.string().trim().max(2000).optional(),
      phone: z.string().trim().min(6).max(20).optional(),
      reason: reason.optional(),
    })
    .refine((b) => b.name !== undefined || b.description !== undefined || b.phone !== undefined, {
      message: "Change at least one field",
    }),
});

const remove = z.object({
  body: z.object({ reason, confirmName: z.string().trim().min(1, "Type the salon name") }),
});

export const AdminSalonsValidation = {
  list,
  updateStatus,
  withReason,
  optionalReason,
  updateLocation,
  updateListing,
  remove,
};
