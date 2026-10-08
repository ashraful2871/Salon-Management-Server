import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import { loadAdminContext } from "../admin.middleware";
import { InvitationService } from "../invitations/invitation.service";
import { AdminAgentsService } from "./agents.service";

const ok = (res: Response, message: string, data: unknown, meta?: unknown) =>
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message, data, meta: meta as never });

const list = catchAsync(async (req: Request, res: Response) => {
  const admin = await loadAdminContext(req);
  const result = await AdminAgentsService.listAgents(admin, req.query);
  ok(res, "Agents", result.data, result.meta);
});

const updateArea = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Agent area updated", await AdminAgentsService.updateArea(req.auditCtx, req.params.id, req.body));
});

const updateStatus = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Agent status updated", await AdminAgentsService.updateStatus(req.auditCtx, req.params.id, req.body));
});

const areas = catchAsync(async (_req: Request, res: Response) => {
  ok(res, "Areas", await AdminAgentsService.listAreas());
});

const resendInvitation = catchAsync(async (req: Request, res: Response) => {
  const { userId } = await loadAdminContext(req);
  ok(
    res,
    "Invitation sent again",
    await InvitationService.resendInvitation(req.params.id, "AGENT", userId, req.auditCtx),
  );
});

const revokeInvitation = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Invitation revoked", await InvitationService.revokeInvitation(req.params.id, "AGENT", req.auditCtx));
});

export const AdminAgentsController = {
  list,
  updateArea,
  updateStatus,
  areas,
  resendInvitation,
  revokeInvitation,
};
