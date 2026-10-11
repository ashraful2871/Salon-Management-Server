import { z } from "zod";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** Why an admin cancelled a booking for the customer. OTHER needs a note. */
export const BOOKING_CANCEL_REASON_CODES = [
  "CUSTOMER_REQUEST",
  "SALON_UNAVAILABLE",
  "DUPLICATE",
  "PAYMENT_ISSUE",
  "FRAUD",
  "OTHER",
] as const;
export type BookingCancelReasonCode = (typeof BOOKING_CANCEL_REASON_CODES)[number];

export const BOOKING_CANCEL_REASON_LABELS: Record<BookingCancelReasonCode, string> = {
  CUSTOMER_REQUEST: "The customer asked us to cancel",
  SALON_UNAVAILABLE: "The salon cannot take the booking",
  DUPLICATE: "Duplicate booking",
  PAYMENT_ISSUE: "Payment problem",
  FRAUD: "Suspected fraud",
  OTHER: "Other",
};

const list = z.object({
  query: z.object({
    q: z.string().max(100).optional(),
    status: z
      .enum(["PENDING", "CONFIRMED", "CHECKED_IN", "IN_PROGRESS", "COMPLETED", "CANCELLED", "NO_SHOW"])
      .optional(),
    salonId: z.string().uuid().optional(),
    area: z.string().max(60).optional(),
    from: ymd.optional(),
    to: ymd.optional(),
    dateField: z.enum(["appointmentDate", "createdAt"]).optional(),
    channel: z.enum(["WEB", "ASSISTANT", "WALK_IN"]).optional(),
    source: z.enum(["PLATFORM", "SALON_DIRECT"]).optional(),
    depositStatus: z.enum(["NONE", "HELD", "RELEASED", "APPLIED", "FORFEITED", "PARTIALLY_FORFEITED"]).optional(),
    appealStatus: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
    includeTest: z.enum(["true", "false"]).optional(),
    sort: z.string().max(40).optional(),
    page: z.string().optional(),
    limit: z.string().optional(),
  }),
});

const cancel = z.object({
  body: z
    .object({
      reasonCode: z.enum(BOOKING_CANCEL_REASON_CODES),
      note: z.string().trim().max(500).optional(),
      notify: z.boolean().default(true),
    })
    .refine((b) => b.reasonCode !== "OTHER" || (b.note?.length ?? 0) >= 3, {
      message: "Add a note when the reason is Other",
      path: ["note"],
    }),
});

const reverseNoShow = z.object({
  body: z.object({ reason: z.string().trim().min(3, "Give a reason").max(500) }),
});

export const AdminBookingsValidation = { list, cancel, reverseNoShow };
