import { z } from "zod";

const page = z.coerce.number().int().min(1).max(10_000).optional();

/** Loose on purpose: a malformed code answers `valid: false`, same as an unknown one. */
const codeLookup = z.object({
  params: z.object({ code: z.string().min(1).max(40) }),
});

const friendsQuery = z.object({
  query: z.object({ page }),
});

export const REWARD_STATUSES = ["PENDING_REVIEW", "AVAILABLE", "RESERVED", "REDEEMED", "EXPIRED", "REVOKED"] as const;

const rewardsQuery = z.object({
  query: z.object({ page, status: z.enum(REWARD_STATUSES).optional() }),
});

export const ReferralValidation = { codeLookup, friendsQuery, rewardsQuery };

// ---------------------------------------------------------------------------
// Admin (/admin/referrals). Days are Asia/Dhaka "YYYY-MM-DD", like analytics.
// ---------------------------------------------------------------------------

export const REFERRAL_STATUSES = ["PENDING_VERIFICATION", "JOINED", "QUALIFIED", "REJECTED", "EXPIRED"] as const;
export const REWARD_KINDS = ["REFEREE_WELCOME", "REFERRER_BONUS", "MANUAL_GRANT"] as const;

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const day = z.string().refine(isDay, "Use YYYY-MM-DD").optional();
const truthy = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .optional()
  .transform((v) => v === true || v === "true" || v === "1");
const triState = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === "true" || v === "1"));
const text = z.string().trim().max(120).optional().transform((v) => v || undefined);
const id = z.string().trim().min(1).max(64);
const reason = z.string().trim().min(3, "A reason is required").max(500);
const optionalReason = z.string().trim().max(500).optional().transform((v) => v || undefined);

const listShape = {
  status: z.enum(REFERRAL_STATUSES).optional(),
  flagged: triState,
  q: text,
  from: day,
  to: day,
  includeTest: truthy,
  page,
};
const rewardListShape = {
  kind: z.enum(REWARD_KINDS).optional(),
  status: z.enum(REWARD_STATUSES).optional(),
  q: text,
  includeTest: truthy,
  page,
};

/**
 * Query schemas. validateRequest does not replace `req.query`, so handlers
 * parse with these themselves (a ZodError answers 400 like any other).
 */
export const ReferralAdminQueries = {
  overview: z.object({ from: day, to: day, includeTest: truthy }),
  list: z.object(listShape),
  rewards: z.object(rewardListShape),
  exportType: z.object({ type: z.enum(["referrals", "rewards"]) }),
};

export type AdminReferralListQuery = z.infer<typeof ReferralAdminQueries.list>;
export type AdminRewardListQuery = z.infer<typeof ReferralAdminQueries.rewards>;

const adminId = z.object({ params: z.object({ id }) });
const adminUserId = z.object({ params: z.object({ userId: id }) });

const adminApprove = z.object({ params: z.object({ id }), body: z.object({ reason: optionalReason }).default({ reason: undefined }) });
const adminReject = z.object({ params: z.object({ id }), body: z.object({ reason }) });
const adminRevoke = z.object({ params: z.object({ id }), body: z.object({ reason }) });
const adminUserReason = z.object({ params: z.object({ userId: id }), body: z.object({ reason }) });
const adminUserOptionalReason = z.object({
  params: z.object({ userId: id }),
  body: z.object({ reason: optionalReason }).default({ reason: undefined }),
});

/** Same bounds as the referral.* settings (percent 1–50, cap 0–5,000 taka, 1–365 days). */
const adminGrant = z.object({
  body: z.object({
    userId: id,
    percent: z.coerce.number().int().min(1).max(50),
    maxDiscountMinor: z.coerce.number().int().min(0).max(500_000),
    validDays: z.coerce.number().int().min(1).max(365),
    scope: z.enum(["ALL", "SALON", "HOME"]),
    reason,
  }),
});

export const ReferralAdminValidation = {
  adminId,
  adminUserId,
  adminApprove,
  adminReject,
  adminRevoke,
  adminUserReason,
  adminUserOptionalReason,
  adminGrant,
};
