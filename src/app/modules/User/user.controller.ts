import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { UserService } from "./user.service";
import ApiError from "../../Error/error";
import { assertAdminPermission } from "../Admin/admin.middleware";
import { audit } from "../../utils/audit";

const reasonOf = (req: Request): string | undefined => {
  const r = req.body?.reason ?? req.query.reason;
  return typeof r === "string" ? r : undefined;
};

/**
 * GET/PATCH /users/:id are open to every role so people can manage their own
 * profile; anyone else's record is the admin's alone. 404 rather than 403, so
 * the answer does not confirm that the id exists.
 */
const assertSelfOrAdmin = (req: Request, id: string) => {
  const isSelf = req.user?.userId === id;
  const isAdmin = req.user?.role === "ADMIN";

  if (!isSelf && !isAdmin) {
    throw new ApiError(StatusCodes.NOT_FOUND, "User not found");
  }
};

const getAllUsers = catchAsync(async (req: Request, res: Response) => {
  const result = await UserService.getAllUsers(req.query);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Users retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

const getMyCustomers = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  const result = await UserService.getMyCustomers(userId, req.query);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Customers retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

const getUserById = catchAsync(async (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  assertSelfOrAdmin(req, id);
  if (req.user?.userId !== id) await assertAdminPermission(req, "users.view");
  const result = await UserService.getUserById(id);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "User retrieved successfully",
    data: result,
  });
});

const updateUser = catchAsync(async (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  assertSelfOrAdmin(req, id);
  const byAdmin = req.user?.userId !== id;
  if (byAdmin) await assertAdminPermission(req, "users.manage");
  const result = await UserService.updateUser(id, req.body);
  if (byAdmin) {
    await audit(req.auditCtx, {
      action: "user.update",
      entityType: "user",
      entityId: id,
      after: req.body,
      reason: reasonOf(req),
    });
  }

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "User updated successfully",
    data: result,
  });
});

const updateUserStatus = catchAsync(async (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const result = await UserService.updateUserStatus(id, req.body.status, {
    ctx: req.auditCtx,
    reason: reasonOf(req),
  });

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "User status updated successfully",
    data: result,
  });
});

const updateUserRole = catchAsync(async (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const result = await UserService.updateUserRole(
    id,
    req.body.role,
    req.user?.userId,
    { ctx: req.auditCtx, reason: reasonOf(req) },
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "User role updated successfully",
    data: result,
  });
});

const deleteUser = catchAsync(async (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  await UserService.deleteUser(id, { ctx: req.auditCtx, reason: reasonOf(req) });

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "User deleted successfully",
    data: null,
  });
});

export const UserController = {
  getAllUsers,
  getMyCustomers,
  getUserById,
  updateUser,
  updateUserStatus,
  updateUserRole,
  deleteUser,
};
