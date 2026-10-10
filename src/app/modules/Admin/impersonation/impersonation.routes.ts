import express, { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import validateRequest from "../../../middlewares/validateRequest";
import { adminSensitiveLimiter } from "../../../middlewares/rateLimiter";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import { adminAuth, adminOnly, loadAdminContext, requireStepUp } from "../admin.middleware";
import { AdminUsersValidation } from "../users/users.validation";
import { ImpersonationService } from "./impersonation.service";

/** /admin/impersonate - read-only "View as" (users.impersonate, tier 3). */
const router = express.Router();

const endSchema = z.object({
  body: z.object({ token: z.string().max(4000).optional() }).default({}),
});

router.post(
  "/end",
  adminAuth(),
  adminOnly,
  validateRequest(endSchema, { replaceBody: true }),
  catchAsync(async (req: Request, res: Response) => {
    const admin = await loadAdminContext(req);
    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: "View as ended",
      data: await ImpersonationService.end(admin, req.auditCtx, req.body.token),
    });
  }),
);

router.post(
  "/:userId",
  adminAuth("users.impersonate"),
  adminOnly,
  validateRequest(AdminUsersValidation.withReason, { replaceBody: true }),
  adminSensitiveLimiter,
  requireStepUp(),
  catchAsync(async (req: Request, res: Response) => {
    const admin = await loadAdminContext(req);
    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: "Viewing as this user (read-only)",
      data: await ImpersonationService.start(admin, req.auditCtx, req.params.userId, req.body.reason),
    });
  }),
);

export const AdminImpersonationRoutes = router;
