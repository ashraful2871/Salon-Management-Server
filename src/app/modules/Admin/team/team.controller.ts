import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import { loadAdminContext } from "../admin.middleware";
import { InvitationService } from "../invitations/invitation.service";
import { AdminTeamService } from "./team.service";

const ok = (res: Response, message: string, data: unknown) =>
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message, data });

const list = catchAsync(async (_req: Request, res: Response) => {
  ok(res, "Team", await AdminTeamService.listTeam());
});

const changeRole = catchAsync(async (req: Request, res: Response) => {
  const admin = await loadAdminContext(req);
  const { adminRole, reason } = req.body;
  ok(
    res,
    "Admin role changed",
    await AdminTeamService.changeRole(admin, req.auditCtx, req.params.userId, adminRole, reason),
  );
});

const remove = catchAsync(async (req: Request, res: Response) => {
  const admin = await loadAdminContext(req);
  ok(
    res,
    "Removed from the team",
    await AdminTeamService.removeMember(admin, req.auditCtx, req.params.userId, req.body.reason),
  );
});

const resetMfa = catchAsync(async (req: Request, res: Response) => {
  const admin = await loadAdminContext(req);
  ok(
    res,
    "Two-factor sign-in reset",
    await AdminTeamService.resetMfa(admin, req.auditCtx, req.params.userId, req.body.reason),
  );
});

const resendInvitation = catchAsync(async (req: Request, res: Response) => {
  const { userId } = await loadAdminContext(req);
  ok(
    res,
    "Invitation sent again",
    await InvitationService.resendInvitation(req.params.id, "ADMIN", userId, req.auditCtx),
  );
});

const revokeInvitation = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Invitation revoked", await InvitationService.revokeInvitation(req.params.id, "ADMIN", req.auditCtx));
});

export const AdminTeamController = {
  list,
  changeRole,
  remove,
  resetMfa,
  resendInvitation,
  revokeInvitation,
};
