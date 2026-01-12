import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { StaffService } from "./staff.service";

const addStaff = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId;

  const result = await StaffService.addStaff(userId, req.body);

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: "Staff added successfully",
    data: result,
  });
});

const getAllStaff = catchAsync(async (req: Request, res: Response) => {
  const result = await StaffService.getAllStaff(req.query);

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
  const userId = req.user?.userId;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const result = await StaffService.updateStaff(userId, id, req.body);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Staff updated successfully",
    data: result,
  });
});

const removeStaff = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  await StaffService.removeStaff(userId, id);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Staff removed successfully",
    data: null,
  });
});

export const StaffController = {
  addStaff,
  getAllStaff,
  getStaffById,
  updateStaff,
  removeStaff,
};
