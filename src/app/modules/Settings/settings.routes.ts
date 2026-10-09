import express, { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { publicSettings } from "../../utils/settings";

/** GET /settings/public - only the settings marked public, no auth. */
const router = express.Router();

router.get(
  "/public",
  catchAsync(async (_req: Request, res: Response) => {
    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: "Public settings",
      data: await publicSettings(),
    });
  }),
);

export const SettingsRoutes = router;
