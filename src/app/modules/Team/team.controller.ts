import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { withAccessCache } from "../../utils/salonAccess";
import { buildAuditCtx } from "../Admin/admin.middleware";
import { TeamService } from "./team.service";

const param = (req: Request, key: string) => {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] : value;
};

const ctxOf = (req: Request) => buildAuditCtx(req, req.user!.role);

const listMembers = catchAsync(async (req: Request, res: Response) => {
  const data = await TeamService.listMembers(withAccessCache(req), param(req, "salonId"), req.query);
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Team members", data });
});

const updateMember = catchAsync(async (req: Request, res: Response) => {
  const data = await TeamService.updateMember(
    withAccessCache(req),
    param(req, "salonId"),
    param(req, "memberId"),
    req.body,
    ctxOf(req),
  );
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Team member updated", data });
});

const removeMember = catchAsync(async (req: Request, res: Response) => {
  const data = await TeamService.removeMember(
    withAccessCache(req),
    param(req, "salonId"),
    param(req, "memberId"),
    ctxOf(req),
  );
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Team member removed", data });
});

const leave = catchAsync(async (req: Request, res: Response) => {
  const data = await TeamService.leave(withAccessCache(req), param(req, "salonId"), ctxOf(req));
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "You left this branch", data });
});

const invite = catchAsync(async (req: Request, res: Response) => {
  const data = await TeamService.invite(withAccessCache(req), param(req, "salonId"), req.body, ctxOf(req));
  sendResponse(res, { statusCode: StatusCodes.CREATED, success: true, message: "Invitation sent", data });
});

const listInvitations = catchAsync(async (req: Request, res: Response) => {
  const data = await TeamService.listInvitations(withAccessCache(req), param(req, "salonId"));
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Pending invitations", data });
});

const resend = catchAsync(async (req: Request, res: Response) => {
  const data = await TeamService.resend(withAccessCache(req), param(req, "id"), ctxOf(req));
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Invitation sent again", data });
});

const revoke = catchAsync(async (req: Request, res: Response) => {
  await TeamService.revoke(withAccessCache(req), param(req, "id"), ctxOf(req));
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Invitation withdrawn", data: null });
});

const preview = catchAsync(async (req: Request, res: Response) => {
  const data = await TeamService.preview(String(req.query.token), req.user?.userId);
  res.set("Cache-Control", "no-store");
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Invitation", data });
});

const accept = catchAsync(async (req: Request, res: Response) => {
  const data = await TeamService.accept(req.body.token, req.user!.userId, ctxOf(req));
  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Invitation accepted. Sign in again to continue.",
    data,
  });
});

export const TeamController = {
  listMembers,
  updateMember,
  removeMember,
  leave,
  invite,
  listInvitations,
  resend,
  revoke,
  preview,
  accept,
};
