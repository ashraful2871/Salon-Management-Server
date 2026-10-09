import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import { AdminSettingsService } from "./settings.service";

const list = catchAsync(async (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Settings",
    data: await AdminSettingsService.listSettings(),
  });
});

const history = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Setting history",
    data: await AdminSettingsService.getHistory(req.params.key),
  });
});

const update = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Setting saved",
    data: await AdminSettingsService.updateSetting(req.auditCtx, req.params.key, req.body),
  });
});

export const AdminSettingsController = { list, history, update };
