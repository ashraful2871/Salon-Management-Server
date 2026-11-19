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
