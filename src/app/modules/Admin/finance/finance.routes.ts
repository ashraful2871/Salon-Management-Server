import express, { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import { adminSensitiveLimiter } from "../../../middlewares/rateLimiter";
import validateRequest from "../../../middlewares/validateRequest";
import { SettlementService } from "../../Settlement/settlement.service";
import { adminAuth, adminOnly, requireStepUp } from "../admin.middleware";
import { exportCsv } from "./finance.export";
import { PayoutAccountReview } from "./finance.payoutAccounts";
import { AdminFinanceService, parseRange } from "./finance.service";

/**
 * /admin/finance - the finance console's reads, the payout preview, wallet
 * freeze and the CSV exports. Money moves stay on their existing routes
 * (`/settlements/payouts*`, `/wallet/admin/adjust`, `/payments/admin/*`),
 * which carry the four-eyes check.
 */
const router = express.Router();

const freezeBody = z.object({
  body: z.object({
    frozen: z.boolean(),
    reason: z.string().trim().min(1, "A reason is required").max(500),
  }),
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

const reasonBody = z.object({
  body: z.object({ reason: z.string().trim().min(3, "A reason is required").max(500) }),
});

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
