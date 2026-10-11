import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import { isSettingKey, SETTINGS } from "../../../utils/settings";
import { requireApprovalIf } from "../approvals/approvals.service";
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
  const { key } = req.params;
  // The route already checked the key exists and the caller may change it.
  // Every money setting (and any key flagged `approval`) needs a second admin.
  if (
    isSettingKey(key) &&
    (await requireApprovalIf(req, res, "setting.update", Boolean(SETTINGS[key].approval) || SETTINGS[key].group === "money", {
      payload: { key, value: req.body.value, reason: req.body.reason },
      summary: `Change ${key} to ${JSON.stringify(req.body.value)}`,
      reason: req.body.reason,
    }))
  ) {
    return;
  }

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Setting saved",
    data: await AdminSettingsService.updateSetting(req.auditCtx, key, req.body),
  });
});

export const AdminSettingsController = { list, history, update };
