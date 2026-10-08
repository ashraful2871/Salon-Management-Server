import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import { loadAdminContext } from "../admin.middleware";
import { AdminMeService } from "./me.service";

// Secrets and recovery codes in these replies are shown once; never cache.
const noStore = (res: Response) => res.set("Cache-Control", "no-store");

const setup = catchAsync(async (req: Request, res: Response) => {
  const { userId } = await loadAdminContext(req);
  const data = await AdminMeService.setup(userId);
  noStore(res);
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Scan the QR code with your authenticator app", data });
});

const activate = catchAsync(async (req: Request, res: Response) => {
  const { userId } = await loadAdminContext(req);
  const data = await AdminMeService.activate(userId, req.body.code, req.auditCtx);
  noStore(res);
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Two-factor sign-in is on", data });
});

const stepUp = catchAsync(async (req: Request, res: Response) => {
  const { userId } = await loadAdminContext(req);
  const data = await AdminMeService.stepUp(userId, req.body.code);
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Confirmed", data });
});

const regenerateRecoveryCodes = catchAsync(async (req: Request, res: Response) => {
  const { userId } = await loadAdminContext(req);
  const data = await AdminMeService.regenerateRecoveryCodes(userId, req.auditCtx);
  noStore(res);
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "New recovery codes", data });
});

export const AdminMeController = {
  setup,
  activate,
  stepUp,
  regenerateRecoveryCodes,
};
