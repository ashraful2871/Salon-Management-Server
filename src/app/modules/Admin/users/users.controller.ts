import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import { loadAdminContext } from "../admin.middleware";
import { AdminUsersService } from "./users.service";

type Query = Record<string, string | undefined>;

const ok = (res: Response, message: string, result: { meta?: unknown; data: unknown }) =>
  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message,
    meta: result.meta as never,
    data: result.data,
  });

const list = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Users", await AdminUsersService.listUsers(req.query as Query));
});

const get = catchAsync(async (req: Request, res: Response) => {
  const admin = await loadAdminContext(req);
  ok(res, "User", { data: await AdminUsersService.getUser(admin, req.params.id) });
});

const bookings = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Bookings", await AdminUsersService.listBookings(req.params.id, req.query as Query));
});

const wallet = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Wallet", await AdminUsersService.listWallet(req.params.id, req.query as Query));
});

const reviews = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Reviews", await AdminUsersService.listReviews(req.params.id, req.query as Query));
});

const activity = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Activity", await AdminUsersService.listActivity(req.params.id, req.query as Query));
});

const impact = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Impact", { data: await AdminUsersService.getImpact(req.params.id) });
});

const updateStatus = catchAsync(async (req: Request, res: Response) => {
  const admin = await loadAdminContext(req);
  const data = await AdminUsersService.updateStatus(admin, req.auditCtx, req.params.id, req.body);
  ok(res, data.status === "ACTIVE" ? "Account reactivated" : `Account ${data.status.toLowerCase()}`, { data });
});

const revokeSessions = catchAsync(async (req: Request, res: Response) => {
  const admin = await loadAdminContext(req);
  ok(res, "Signed out everywhere", {
    data: await AdminUsersService.revokeSessions(admin, req.auditCtx, req.params.id, req.body?.reason),
  });
});

const verifyEmail = catchAsync(async (req: Request, res: Response) => {
  const admin = await loadAdminContext(req);
  ok(res, "Email marked verified", {
    data: await AdminUsersService.verifyEmail(admin, req.auditCtx, req.params.id, req.body.reason),
  });
});

const updateRole = catchAsync(async (req: Request, res: Response) => {
  const admin = await loadAdminContext(req);
  ok(res, "Account type changed", {
    data: await AdminUsersService.updateRole(admin, req.auditCtx, req.params.id, req.body.role, req.body.reason),
  });
});

export const AdminUsersController = {
  list,
  get,
  bookings,
  wallet,
  reviews,
  activity,
  impact,
  updateStatus,
  revokeSessions,
  verifyEmail,
  updateRole,
};
