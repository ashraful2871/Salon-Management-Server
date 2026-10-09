import { z } from "zod";

const takaAmount = z
  .number()
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9, {
    message: "Amount cannot be smaller than one poisha (0.01)",
  });

const runPayoutBatchValidation = z.object({
  body: z.object({
    periodStart: z.string().optional(),
    periodEnd: z.string().optional(),
    reason: z.string().trim().max(500).optional(),
  }),
});

const updatePayoutStatusValidation = z.object({
  body: z.object({
    status: z.enum(["PENDING", "PROCESSING", "PAID", "FAILED"]),
    method: z.enum(["BKASH", "BANK"]).optional(),
    // Required when marking PAID - the service enforces that, because a payout
    // with no transfer reference cannot be traced later.
    reference: z.string().trim().max(120).optional(),
    // A link to the transfer screenshot or bank advice. Optional.
    proofUrl: z.string().trim().url().max(500).optional(),
    failureReason: z.string().trim().max(500).optional(),
    reason: z.string().trim().max(500).optional(),
  }),
});

const commissionRuleBody = {
  salonId: z.string().nullable().optional(),
  minAmount: takaAmount.nonnegative().optional(),
  maxAmount: takaAmount.nonnegative().optional(),
  flatFee: takaAmount.nonnegative().optional(),
  // Basis points, not money: 500 = 5%.
  percentBps: z.number().int().min(0).max(10000).nullable().optional(),
  appliesTo: z.enum(["NEW_CUSTOMER", "OFF_PEAK", "ALL"]),
  priority: z.number().int().optional(),
  reason: z.string().trim().max(500).optional(),
};

const createCommissionRuleValidation = z.object({
  body: z.object(commissionRuleBody),
});

const updateCommissionRuleValidation = z.object({
  body: z.object({
    ...commissionRuleBody,
    appliesTo: z.enum(["NEW_CUSTOMER", "OFF_PEAK", "ALL"]).optional(),
    isActive: z.boolean().optional(),
  }),
});

export const SettlementValidation = {
  runPayoutBatchValidation,
  updatePayoutStatusValidation,
  createCommissionRuleValidation,
  updateCommissionRuleValidation,
};
