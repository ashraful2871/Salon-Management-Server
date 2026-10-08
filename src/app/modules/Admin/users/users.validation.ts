import { z } from "zod";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const bool = z.enum(["true", "false"]);

/** Why an account's status changed. OTHER needs a note. */
export const STATUS_REASON_CODES = [
  "FRAUD",
  "ABUSE",
  "SPAM",
  "PAYMENT_ISSUE",
  "POLICY_VIOLATION",
  "USER_REQUEST",
  "RESOLVED",
  "OTHER",
] as const;

export const REASON_LABELS: Record<(typeof STATUS_REASON_CODES)[number], string> = {
  FRAUD: "Suspected fraud",
  ABUSE: "Abusive behaviour",
  SPAM: "Spam or fake bookings",
  PAYMENT_ISSUE: "Payment issue",
  POLICY_VIOLATION: "Breach of our terms",
  USER_REQUEST: "At the account holder's request",
  RESOLVED: "Issue resolved",
  OTHER: "Other",
};

const note = z.string().trim().max(500).optional();
const reason = z.string().trim().min(3, "Give a reason").max(500);

const list = z.object({
  query: z.object({
    q: z.string().max(100).optional(),
    role: z.enum(["CUSTOMER", "STAFF", "SALON_OWNER", "ADMIN", "AGENT"]).optional(),
    status: z.enum(["ACTIVE", "INACTIVE", "SUSPENDED", "BLOCKED"]).optional(),
    verified: bool.optional(),
    from: ymd.optional(),
    to: ymd.optional(),
    hasBookings: bool.optional(),
    provider: z.enum(["PASSWORD", "GOOGLE"]).optional(),
    includeTest: bool.optional(),
    sort: z.string().max(40).optional(),
    page: z.string().optional(),
    limit: z.string().optional(),
  }),
});

const updateStatus = z.object({
  body: z
    .object({
      status: z.enum(["ACTIVE", "SUSPENDED", "BLOCKED"]),
      until: z.coerce.date().optional(),
      reasonCode: z.enum(STATUS_REASON_CODES),
      note,
      notify: z.boolean().default(true),
      cancelUpcoming: z.boolean().default(false),
      suspendSalons: z.boolean().default(false),
    })
    .refine((b) => b.reasonCode !== "OTHER" || !!b.note, {
      message: "Add a note when the reason is Other",
      path: ["note"],
    })
    .refine((b) => !b.until || (b.status === "SUSPENDED" && b.until > new Date()), {
      message: "A suspension end must be in the future",
      path: ["until"],
    }),
});

const withReason = z.object({ body: z.object({ reason }) });

const optionalReason = z.object({ body: z.object({ reason: reason.optional() }).default({}) });

const updateRole = z.object({
  body: z.object({ role: z.enum(["CUSTOMER", "STAFF", "SALON_OWNER"]), reason }),
});

export const AdminUsersValidation = {
  list,
  updateStatus,
  withReason,
  optionalReason,
  updateRole,
};
