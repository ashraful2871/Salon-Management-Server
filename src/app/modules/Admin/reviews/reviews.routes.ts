import express, { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import validateRequest from "../../../middlewares/validateRequest";
import { adminAuth, adminOnly } from "../admin.middleware";
import { AdminReviewsService } from "./reviews.service";
import { AdminReviewsValidation } from "./reviews.validation";

/** /admin/reviews - moderation. Reviews are not area-scoped, so agents get none of it. */
const router = express.Router();

router.get(
  "/",
  adminAuth("reviews.moderate"),
  adminOnly,
  validateRequest(AdminReviewsValidation.list),
  catchAsync(async (req: Request, res: Response) => {
    const result = await AdminReviewsService.list(req.query as Record<string, string | undefined>);
    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: "Reviews",
      meta: result.meta as never,
      data: result.data,
    });
  }),
);

// Tier 2.
router.patch(
  "/:id",
  adminAuth("reviews.moderate"),
  adminOnly,
  validateRequest(AdminReviewsValidation.moderate, { replaceBody: true }),
  catchAsync(async (req: Request, res: Response) => {
    const data = await AdminReviewsService.moderate(req.auditCtx, req.user!.userId, String(req.params.id), req.body);
    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: data.status === "HIDDEN" ? "Review hidden" : "Review kept up",
      data,
    });
  }),
);

export const AdminReviewsRoutes = router;
