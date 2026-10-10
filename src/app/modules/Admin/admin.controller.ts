import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { loadAdminContext } from "./admin.middleware";
import { AdminService } from "./admin.service";

const getMe = catchAsync(async (req: Request, res: Response) => {
  const data = await AdminService.getMe(await loadAdminContext(req));
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Admin profile", data });
});

const updateMe = catchAsync(async (req: Request, res: Response) => {
  const data = await AdminService.updateMe(req.admin!, req.auditCtx, req.body);
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Preferences saved", data });
});

const search = catchAsync(async (req: Request, res: Response) => {
  const data = await AdminService.search(await loadAdminContext(req), String(req.query.q ?? ""));
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Search results", data });
});

const inbox = catchAsync(async (req: Request, res: Response) => {
  const data = await AdminService.inbox(await loadAdminContext(req));
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Needs attention", data });
});

const listNotes = catchAsync(async (req: Request, res: Response) => {
  const data = await AdminService.listNotes(
    await loadAdminContext(req),
    req.query.entityType as Parameters<typeof AdminService.listNotes>[1],
    String(req.query.entityId),
  );
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Notes", data });
});

const createNote = catchAsync(async (req: Request, res: Response) => {
  const data = await AdminService.createNote(await loadAdminContext(req), req.auditCtx, req.body);
  sendResponse(res, { statusCode: StatusCodes.CREATED, success: true, message: "Note added", data });
});

const deleteNote = catchAsync(async (req: Request, res: Response) => {
  await AdminService.deleteNote(await loadAdminContext(req), req.auditCtx, req.params.id);
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Note deleted" });
});

export const AdminController = {
  getMe,
  updateMe,
  search,
  inbox,
  listNotes,
  createNote,
  deleteNote,
};
