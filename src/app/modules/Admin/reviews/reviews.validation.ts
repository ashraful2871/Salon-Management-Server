import { z } from "zod";

/** Why a review was hidden. Shared with `components/Admin/reviews/labels.ts`. */
export const REVIEW_HIDE_REASON_CODES = [
  "ABUSIVE",
  "PERSONAL_INFO",
  "SPAM_OR_FAKE",
  "OFF_TOPIC",
  "CONFLICT_OF_INTEREST",
  "OTHER",
] as const;

/** Why a review was put back (or its reports dismissed). */
export const REVIEW_RESTORE_REASON_CODES = ["NOT_A_VIOLATION", "HIDDEN_BY_MISTAKE", "OTHER"] as const;

export const REVIEW_REASON_LABELS: Record<string, string> = {
  ABUSIVE: "Abusive or hateful language",
  PERSONAL_INFO: "It shared someone's personal information",
  SPAM_OR_FAKE: "Spam or not a genuine visit",
  OFF_TOPIC: "Not about the salon or the visit",
  CONFLICT_OF_INTEREST: "Written by someone connected to the salon",
  NOT_A_VIOLATION: "It does not break the guidelines",
  HIDDEN_BY_MISTAKE: "It was hidden by mistake",
  OTHER: "Other",
};

const ALL_CODES = [...new Set([...REVIEW_HIDE_REASON_CODES, ...REVIEW_RESTORE_REASON_CODES])] as [
  string,
  ...string[],
];

const list = z.object({
  query: z.object({
    tab: z.enum(["reported", "low", "all", "hidden"]).optional(),
    salonId: z.string().uuid().optional(),
    rating: z.enum(["1", "2", "3", "4", "5"]).optional(),
    includeTest: z.enum(["true", "false"]).optional(),
    q: z.string().max(100).optional(),
    sort: z.string().max(40).optional(),
    page: z.string().optional(),
    limit: z.string().optional(),
  }),
});

const moderate = z.object({
  body: z
    .object({
      status: z.enum(["HIDDEN", "PUBLISHED"]),
      reasonCode: z.enum(ALL_CODES),
      note: z.string().trim().max(500).optional(),
      notify: z.boolean().default(false),
    })
    .refine(
      (b) =>
        b.status === "HIDDEN"
          ? (REVIEW_HIDE_REASON_CODES as readonly string[]).includes(b.reasonCode)
          : (REVIEW_RESTORE_REASON_CODES as readonly string[]).includes(b.reasonCode),
      { message: "That reason doesn't fit this action", path: ["reasonCode"] },
    )
    .refine((b) => b.reasonCode !== "OTHER" || (b.note?.length ?? 0) >= 3, {
      message: "Add a note when the reason is Other",
      path: ["note"],
    }),
});

export type ReviewModeration = z.infer<typeof moderate>["body"];

export const AdminReviewsValidation = { list, moderate };
