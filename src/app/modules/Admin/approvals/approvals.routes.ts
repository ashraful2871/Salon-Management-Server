import express, { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import { adminSensitiveLimiter } from "../../../middlewares/rateLimiter";
import validateRequest from "../../../middlewares/validateRequest";
import { adminAuth, adminOnly, requireStepUp } from "../admin.middleware";
import { AdminApprovalsService } from "./approvals.service";

/**
 * /admin/approvals - four-eyes requests. Each action's own permission is
 * checked in the service (the list shows what you could decide, plus your
 * own requests). Approving runs the money move, so it is tier 3 (step-up).
 */
const router = express.Router();

const approveBody = z.object({
  body: z.object({ note: z.string().trim().max(500).optional() }),
});
const rejectBody = z.object({
  body: z.object({ note: z.string().trim().min(1, "Say why you are rejecting it").max(500) }),
});

router.get(
  "/",
  adminAuth(),
  adminOnly,
  catchAsync(async (req: Request, res: Response) => {
    const data = await AdminApprovalsService.list(req.admin!, req.query);
    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: "Approvals",
      data,
    });
  }),
);

router.post(
  "/:id/approve",
  adminAuth(),
  adminOnly,
  validateRequest(approveBody, { replaceBody: true }),
  adminSensitiveLimiter,
  requireStepUp(),
  catchAsync(async (req: Request, res: Response) => {
    const data = await AdminApprovalsService.approve(
      req.admin!,
      req.auditCtx,
      req.params.id,
      req.body.note,
    );
    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: "Approved and done",
      data,
    });
  }),
);

router.post(
  "/:id/reject",
  adminAuth(),
  adminOnly,
  validateRequest(rejectBody, { replaceBody: true }),
  adminSensitiveLimiter,
  catchAsync(async (req: Request, res: Response) => {
    const data = await AdminApprovalsService.reject(
      req.admin!,
      req.auditCtx,
      req.params.id,
      req.body.note,
    );
    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: "Request rejected",
      data,
    });
  }),
);

export const AdminApprovalsRoutes = router;
