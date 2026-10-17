import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { StaffService } from "./staff.service";
import { StaffSchedule } from "./staff.schedule";
import { withAccessCache } from "../../utils/salonAccess";
import { buildAuditCtx } from "../Admin/admin.middleware";

const addStaff = catchAsync(async (req: Request, res: Response) => {

  const result = await StaffService.addStaff(
    withAccessCache(req),
    req.body,
    buildAuditCtx(req, req.user!.role),
  );

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: "Invitation sent",
    data: result,
  });
});

const getAllStaff = catchAsync(async (req: Request, res: Response) => {
  const result = await StaffService.getAllStaff(req.query, req.user);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Staff retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

const getStaffById = catchAsync(async (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const result = await StaffService.getStaffById(id);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Staff retrieved successfully",
    data: result,
  });
});

const updateStaff = catchAsync(async (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const result = await StaffService.updateStaff(withAccessCache(req), id, req.body);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Staff updated successfully",
    data: result,
  });
});

const removeStaff = catchAsync(async (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  await StaffService.removeStaff(withAccessCache(req), id, buildAuditCtx(req, req.user!.role));

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Staff removed successfully",
    data: null,
  });
});

const param = (req: Request, key: string) => {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] : value;
};

const getAvailability = catchAsync(async (req: Request, res: Response) => {
  const data = await StaffSchedule.availabilityForAppointment(withAccessCache(req), String(req.query.appointmentId ?? ""));
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Staff availability", data });
});

const getShifts = catchAsync(async (req: Request, res: Response) => {
  const data = await StaffSchedule.getShifts(withAccessCache(req), param(req, "id"));
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Working hours", data });
});

const putShifts = catchAsync(async (req: Request, res: Response) => {
  const data = await StaffSchedule.putShifts(
    withAccessCache(req),
    buildAuditCtx(req, req.user!.role),
    param(req, "id"),
    req.body.shifts,
  );
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Working hours saved", data });
});

const listTimeOff = catchAsync(async (req: Request, res: Response) => {
  const data = await StaffSchedule.listTimeOff(withAccessCache(req), param(req, "id"));
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Time off", data });
});

const addTimeOff = catchAsync(async (req: Request, res: Response) => {
  const data = await StaffSchedule.addTimeOff(
    withAccessCache(req),
    buildAuditCtx(req, req.user!.role),
    param(req, "id"),
    req.body,
  );
  sendResponse(res, { statusCode: StatusCodes.CREATED, success: true, message: "Time off added", data });
});

const deleteTimeOff = catchAsync(async (req: Request, res: Response) => {
  const data = await StaffSchedule.deleteTimeOff(
    withAccessCache(req),
    buildAuditCtx(req, req.user!.role),
    param(req, "id"),
    param(req, "timeOffId"),
  );
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Time off removed", data });
});

export const StaffController = {
  addStaff,
  getAllStaff,
  getStaffById,
  updateStaff,
  removeStaff,
  getAvailability,
  getShifts,
  putShifts,
  listTimeOff,
  addTimeOff,
  deleteTimeOff,
};
