import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import { buildAuditCtx, loadAdminContext } from "../admin.middleware";
import { InvitationService } from "./invitation.service";

const inviteAdmin = catchAsync(async (req: Request, res: Response) => {
  const { userId } = await loadAdminContext(req);
  const data = await InvitationService.createInvitation("ADMIN", req.body, userId, req.auditCtx);
  sendResponse(res, { statusCode: StatusCodes.CREATED, success: true, message: "Invitation sent", data });
});

const inviteAgent = catchAsync(async (req: Request, res: Response) => {
  const { userId } = await loadAdminContext(req);
  const data = await InvitationService.createInvitation("AGENT", req.body, userId, req.auditCtx);
  sendResponse(res, { statusCode: StatusCodes.CREATED, success: true, message: "Invitation sent", data });
});

const preview = catchAsync(async (req: Request, res: Response) => {
  const data = await InvitationService.preview(String(req.query.token), req.user?.userId);
  res.set("Cache-Control", "no-store");
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Invitation", data });
});

const accept = catchAsync(async (req: Request, res: Response) => {
  const data = await InvitationService.accept(
    req.body.token,
    req.user!.userId,
    buildAuditCtx(req, req.user!.role),
  );
  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Invitation accepted. Sign in again to continue.",
    data,
  });
});

export const InvitationController = {
  inviteAdmin,
  inviteAgent,
  preview,
  accept,
};
