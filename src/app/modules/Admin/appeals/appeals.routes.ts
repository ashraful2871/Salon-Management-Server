import express, { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import { adminAuth, adminOnly } from "../admin.middleware";
import { AdminAppealsService } from "./appeals.service";

/**
 * /admin/appeals - the no-show appeal queue. Decisions go through the
 * existing `PATCH /appointments/:id/appeal`, and
 * `POST /admin/bookings/:id/reverse-no-show` covers a no-show nobody appealed.
 */
const router = express.Router();

router.get(
  "/",
  adminAuth("appeals.resolve"),
  adminOnly,
  catchAsync(async (_req: Request, res: Response) => {
    const data = await AdminAppealsService.listPending();
    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: "Appeals",
      meta: { total: data.length } as never,
      data,
    });
  }),
);

export const AdminAppealsRoutes = router;
