import express, { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { adminSensitiveLimiter } from "../../middlewares/rateLimiter";
import validateRequest from "../../middlewares/validateRequest";
import { adminAuth, adminOnly, requireStepUp } from "../Admin/admin.middleware";
import { ReferralAdmin } from "./referral.admin";
import { ReferralAdminValidation as V } from "./referral.validation";

/**
 * /admin/referrals - mounted inside the /admin gate (2FA + profile). Admins
 * only: the program is platform-wide, so agents get none of it. Reads need
 * referrals.view; every write is referrals.manage and tier 3 (step-up + the
 * sensitive limiter), audited in its own transaction.
 */
const router = express.Router();
const tier3 = [adminSensitiveLimiter, requireStepUp()];

const ok = (res: Response, message: string, data: unknown) =>
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message, data });
const page = (res: Response, message: string, result: { meta: unknown; data: unknown }) =>
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message, meta: result.meta as never, data: result.data });

// Fixed paths first, so none of them is read as a referral id.
router.get(
  "/overview",
  adminAuth("referrals.view"),
  adminOnly,
  catchAsync(async (req: Request, res: Response) => ok(res, "Referral overview", await ReferralAdmin.overview(req.query))),
);

// CSV, outside the envelope (contract 12); errors before the first row still use it.
router.get(
  "/export",
  adminAuth("referrals.view", "analytics.export"),
  adminOnly,
  adminSensitiveLimiter,
  catchAsync(ReferralAdmin.exportCsv),
);

router.get(
  "/rewards",
  adminAuth("referrals.view"),
  adminOnly,
  catchAsync(async (req: Request, res: Response) => page(res, "Referral rewards", await ReferralAdmin.listRewards(req.admin, req.query))),
);
router.post(
  "/rewards/grant",
  adminAuth("referrals.manage"),
  adminOnly,
  validateRequest(V.adminGrant, { replaceBody: true }),
  ...tier3,
  catchAsync(async (req: Request, res: Response) => {
    const data = await ReferralAdmin.grantReward(req.auditCtx, req.body);
    sendResponse(res, { statusCode: StatusCodes.CREATED, success: true, message: "Reward granted", data });
  }),
);
router.post(
  "/rewards/:id/revoke",
  adminAuth("referrals.manage"),
  adminOnly,
  validateRequest(V.adminRevoke, { replaceBody: true }),
  ...tier3,
  catchAsync(async (req: Request, res: Response) =>
    ok(res, "Reward revoked", await ReferralAdmin.revokeReward(req.auditCtx, req.params.id, req.body.reason)),
  ),
);

router.post(
  "/users/:userId/code/reset",
  adminAuth("referrals.manage"),
  adminOnly,
  validateRequest(V.adminUserOptionalReason, { replaceBody: true }),
  ...tier3,
  catchAsync(async (req: Request, res: Response) =>
    ok(res, "Referral code reset; the old code no longer works", await ReferralAdmin.adminResetCode(req.auditCtx, req.params.userId, req.body?.reason)),
  ),
);
router.post(
  "/users/:userId/block",
  adminAuth("referrals.manage"),
  adminOnly,
  validateRequest(V.adminUserReason, { replaceBody: true }),
  ...tier3,
  catchAsync(async (req: Request, res: Response) =>
    ok(res, "Blocked from the referral program", await ReferralAdmin.blockUser(req.auditCtx, req.params.userId, req.body.reason)),
  ),
);
router.post(
  "/users/:userId/unblock",
  adminAuth("referrals.manage"),
  adminOnly,
  validateRequest(V.adminUserOptionalReason, { replaceBody: true }),
  ...tier3,
  catchAsync(async (req: Request, res: Response) =>
    ok(res, "Unblocked from the referral program", await ReferralAdmin.unblockUser(req.auditCtx, req.params.userId, req.body?.reason)),
  ),
);

router.get(
  "/",
  adminAuth("referrals.view"),
  adminOnly,
  catchAsync(async (req: Request, res: Response) => page(res, "Referrals", await ReferralAdmin.listReferrals(req.admin, req.query))),
);
router.get(
  "/:id",
  adminAuth("referrals.view"),
  adminOnly,
  validateRequest(V.adminId),
  catchAsync(async (req: Request, res: Response) => ok(res, "Referral", await ReferralAdmin.getReferral(req.admin, req.params.id))),
);
router.post(
  "/:id/approve",
  adminAuth("referrals.manage"),
  adminOnly,
  validateRequest(V.adminApprove, { replaceBody: true }),
  ...tier3,
  catchAsync(async (req: Request, res: Response) =>
    ok(res, "Reward approved and released", await ReferralAdmin.approveReferral(req.auditCtx, req.params.id, req.body?.reason)),
  ),
);
router.post(
  "/:id/reject",
  adminAuth("referrals.manage"),
  adminOnly,
  validateRequest(V.adminReject, { replaceBody: true }),
  ...tier3,
  catchAsync(async (req: Request, res: Response) =>
    ok(res, "Referral rejected", await ReferralAdmin.rejectReferral(req.auditCtx, req.params.id, req.body.reason)),
  ),
);

export const ReferralAdminRoutes = router;
