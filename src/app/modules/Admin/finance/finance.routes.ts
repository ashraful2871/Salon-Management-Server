import express, { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { PayoutStatus } from "@prisma/client";
import { z } from "zod";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import { adminSensitiveLimiter } from "../../../middlewares/rateLimiter";
import validateRequest from "../../../middlewares/validateRequest";
import { SettlementService } from "../../Settlement/settlement.service";
import { adminAuth, adminOnly, requireStepUp } from "../admin.middleware";
import { exportCsv } from "./finance.export";
import { approvePayout, approvePayouts, exportPayoutFile, markPaid } from "./finance.payouts";
import { PayoutAccountReview } from "./finance.payoutAccounts";
import { AdminFinanceService, parseRange } from "./finance.service";

/**
 * /admin/finance - the finance console's reads, the payout preview, the
 * weekly payout desk (approve / processing / cancel / fail / mark paid and the
 * bKash / BEFTN transfer files), wallet freeze and the CSV exports. Other
 * money moves stay on their existing routes (`/settlements/payouts*`,
 * `/wallet/admin/adjust`, `/payments/admin/*`), which carry the four-eyes check.
 */
const router = express.Router();

const freezeBody = z.object({
  body: z.object({
    frozen: z.boolean(),
    reason: z.string().trim().min(1, "A reason is required").max(500),
  }),
});
const reasonBody = z.object({
  body: z.object({ reason: z.string().trim().min(3, "A reason is required").max(500) }),
});
const previewBody = z.object({
  body: z.object({ periodEnd: z.string().optional() }),
});

const ok = (res: Response, message: string, data: unknown, meta?: unknown) =>
  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message,
    ...(meta ? { meta: meta as never } : {}),
    data,
  });

router.get(
  "/overview",
  adminAuth("finance.view"),
  adminOnly,
  catchAsync(async (req: Request, res: Response) => {
    ok(res, "Finance overview", await AdminFinanceService.overview(req.query));
  }),
);

router.get(
  "/reconciliation",
  adminAuth("finance.view"),
  adminOnly,
  catchAsync(async (_req: Request, res: Response) => {
    ok(res, "Reconciliation", await AdminFinanceService.reconciliation());
  }),
);

router.get(
  "/payouts",
  adminAuth("finance.view"),
  adminOnly,
  catchAsync(async (req: Request, res: Response) => {
    const { meta, data } = await AdminFinanceService.listPayouts(req.query);
    ok(res, "Payouts", data, meta);
  }),
);

router.post(
  "/payouts/preview",
  adminAuth("finance.payouts"),
  adminOnly,
  validateRequest(previewBody, { replaceBody: true }),
  catchAsync(async (req: Request, res: Response) => {
    const periodEnd = req.body.periodEnd ? parseRange({ to: req.body.periodEnd }).to : undefined;
    ok(res, "Payout preview", await SettlementService.previewPayoutBatch({ periodEnd }));
  }),
);

// The weekly payout desk (finance.payouts.ts). Approve, cancel, fail and
// mark-paid are tier 3; processing and the transfer file are tier 2.
const optionalReason = z.string().trim().max(500).optional();
const approveManyBody = z.object({
  body: z.object({ ids: z.array(z.string().uuid()).min(1).max(200), reason: optionalReason }),
});
const markPaidBody = z.object({
  body: z.object({
    items: z
      .array(
        z.object({
          payoutId: z.string().uuid(),
          reference: z.string().trim().min(1, "A reference is required").max(120),
          method: z.enum(["BKASH", "BANK"]),
          proofUrl: z.string().trim().url().max(500).optional(),
        }),
      )
      .min(1)
      .max(200),
    reason: optionalReason,
  }),
});
const approveOneBody = z.object({ body: z.object({ reason: optionalReason }) });
const processingBody = z.object({
  body: z.object({ method: z.enum(["BKASH", "BANK"]).optional(), reason: optionalReason }),
});

router.get(
  "/payouts/export.csv",
  adminAuth("finance.export", "finance.payout_accounts"),
  adminOnly,
  adminSensitiveLimiter,
  catchAsync(exportPayoutFile),
);

router.post(
  "/payouts/approve",
  adminAuth("finance.payouts"),
  adminOnly,
  validateRequest(approveManyBody, { replaceBody: true }),
  adminSensitiveLimiter,
  requireStepUp(),
  catchAsync(async (req: Request, res: Response) => {
    const results = await approvePayouts(req, req.body.ids, req.body.reason);
    ok(res, `${results.filter((r) => r.ok).length} of ${results.length} approved or sent for approval`, results);
  }),
);

router.post(
  "/payouts/mark-paid",
  adminAuth("finance.payouts"),
  adminOnly,
  validateRequest(markPaidBody, { replaceBody: true }),
  adminSensitiveLimiter,
  requireStepUp(),
  catchAsync(async (req: Request, res: Response) => {
    const results = await markPaid(req, req.body.items, req.body.reason);
    ok(res, `${results.filter((r) => r.ok).length} of ${results.length} marked paid`, results);
  }),
);

router.post(
  "/payouts/:id/approve",
  adminAuth("finance.payouts"),
  adminOnly,
  validateRequest(approveOneBody, { replaceBody: true }),
  adminSensitiveLimiter,
  requireStepUp(),
  catchAsync(async (req: Request, res: Response) => {
    const result = await approvePayout(req, req.params.id, req.body.reason);
    if (result.ok && result.status === "APPROVAL_REQUIRED") {
      sendResponse(res, {
        statusCode: StatusCodes.ACCEPTED,
        success: true,
        message: "Sent for approval",
        data: { status: "APPROVAL_REQUIRED", approvalId: result.approvalId },
      });
      return;
    }
    ok(res, "Payout approved", result);
  }),
);

router.post(
  "/payouts/:id/processing",
  adminAuth("finance.payouts"),
  adminOnly,
  validateRequest(processingBody, { replaceBody: true }),
  catchAsync(async (req: Request, res: Response) => {
    const data = await SettlementService.transitionPayout(
      req.params.id,
      PayoutStatus.PROCESSING,
      { method: req.body.method },
      { ctx: req.auditCtx, reason: req.body.reason },
    );
    ok(res, "Payout marked processing", data);
  }),
);

router.post(
  "/payouts/:id/cancel",
  adminAuth("finance.payouts"),
  adminOnly,
  validateRequest(reasonBody, { replaceBody: true }),
  adminSensitiveLimiter,
  requireStepUp(),
  catchAsync(async (req: Request, res: Response) => {
    const data = await SettlementService.transitionPayout(
      req.params.id,
      PayoutStatus.CANCELLED,
      { cancelledReason: req.body.reason },
      { ctx: req.auditCtx, reason: req.body.reason },
    );
    ok(res, "Payout cancelled; its money is back in the balance", data);
  }),
);

router.post(
  "/payouts/:id/fail",
  adminAuth("finance.payouts"),
  adminOnly,
  validateRequest(reasonBody, { replaceBody: true }),
  adminSensitiveLimiter,
  requireStepUp(),
  catchAsync(async (req: Request, res: Response) => {
    const data = await SettlementService.transitionPayout(
      req.params.id,
      PayoutStatus.FAILED,
      { failureReason: req.body.reason },
      { ctx: req.auditCtx, reason: req.body.reason },
    );
    ok(res, "Payout marked failed; its money is back in the balance", data);
  }),
);

router.get(
  "/wallets",
  adminAuth("finance.view"),
  adminOnly,
  catchAsync(async (req: Request, res: Response) => {
    ok(res, "Wallets", await AdminFinanceService.searchWallets(req.admin!, req.query));
  }),
);

router.get(
  "/wallets/:userId/transactions",
  adminAuth("finance.view"),
  adminOnly,
  catchAsync(async (req: Request, res: Response) => {
    const { meta, data } = await AdminFinanceService.walletDetail(
      req.admin!,
      req.params.userId,
      req.query,
    );
    ok(res, "Wallet", data, meta);
  }),
);

router.patch(
  "/wallets/:userId/freeze",
  adminAuth("finance.wallet_freeze"),
  adminOnly,
  validateRequest(freezeBody, { replaceBody: true }),
  adminSensitiveLimiter,
  requireStepUp(),
  catchAsync(async (req: Request, res: Response) => {
    const data = await AdminFinanceService.setFrozen(
      req.admin!,
      req.auditCtx,
      req.params.userId,
      req.body,
    );
    ok(res, data.isFrozen ? "Wallet frozen" : "Wallet unfrozen", data);
  }),
);

router.get(
  "/ledger",
  adminAuth("finance.view"),
  adminOnly,
  catchAsync(async (req: Request, res: Response) => {
    ok(res, "Ledger", await AdminFinanceService.ledger(req.query));
  }),
);

// Tier 2: no step-up, but every export is audited with its filters and size.
router.get(
  "/export/:file",
  adminAuth("finance.export"),
  adminOnly,
  adminSensitiveLimiter,
  catchAsync(exportCsv),
);


// Payout accounts & KYC: list (masked), reveal (users.view_pii, audited),
// verify / reject (tier 3).
router.get(
  "/payout-accounts",
  adminAuth("finance.payout_accounts"),
  adminOnly,
  catchAsync(async (req: Request, res: Response) => {
    const { meta, data } = await PayoutAccountReview.listAccounts(req.query);
    ok(res, "Payout accounts", data, meta);
  }),
);

router.get(
  "/payout-accounts/:id/reveal",
  adminAuth("finance.payout_accounts", "users.view_pii"),
  adminOnly,
  adminSensitiveLimiter,
  catchAsync(async (req: Request, res: Response) => {
    ok(res, "Account number", await PayoutAccountReview.reveal(req.auditCtx, req.params.id));
  }),
);

router.post(
  "/payout-accounts/:id/verify",
  adminAuth("finance.payout_accounts"),
  adminOnly,
  adminSensitiveLimiter,
  requireStepUp(),
  catchAsync(async (req: Request, res: Response) => {
    const data = await PayoutAccountReview.decideAccount(
      req.auditCtx,
      req.user!.userId,
      req.params.id,
      { verified: true },
    );
    ok(res, "Payout account verified", data);
  }),
);

router.post(
  "/payout-accounts/:id/reject",
  adminAuth("finance.payout_accounts"),
  adminOnly,
  validateRequest(reasonBody, { replaceBody: true }),
  adminSensitiveLimiter,
  requireStepUp(),
  catchAsync(async (req: Request, res: Response) => {
    const data = await PayoutAccountReview.decideAccount(
      req.auditCtx,
      req.user!.userId,
      req.params.id,
      { verified: false, reason: req.body.reason },
    );
    ok(res, "Payout account rejected", data);
  }),
);

router.get(
  "/kyc",
  adminAuth("finance.payout_accounts"),
  adminOnly,
  catchAsync(async (req: Request, res: Response) => {
    const { meta, data } = await PayoutAccountReview.listKyc(req.query);
    ok(res, "Business KYC", data, meta);
  }),
);

router.post(
  "/kyc/:ownerId/verify",
  adminAuth("finance.payout_accounts"),
  adminOnly,
  adminSensitiveLimiter,
  requireStepUp(),
  catchAsync(async (req: Request, res: Response) => {
    ok(res, "Business details verified", await PayoutAccountReview.decideKyc(req.auditCtx, req.params.ownerId, { verified: true }));
  }),
);

router.post(
  "/kyc/:ownerId/reject",
  adminAuth("finance.payout_accounts"),
  adminOnly,
  validateRequest(reasonBody, { replaceBody: true }),
  adminSensitiveLimiter,
  requireStepUp(),
  catchAsync(async (req: Request, res: Response) => {
    const data = await PayoutAccountReview.decideKyc(req.auditCtx, req.params.ownerId, {
      verified: false,
      reason: req.body.reason,
    });
    ok(res, "Business details rejected", data);
  }),
);

export const AdminFinanceRoutes = router;
