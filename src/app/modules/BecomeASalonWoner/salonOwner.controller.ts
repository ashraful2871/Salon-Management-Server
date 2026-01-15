import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { SalonOwnerService } from "./salonOwner.service";

const applySalonOwner = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  const result = await SalonOwnerService.applySalonOwner(userId, req.body);

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: "Salon owner application submitted successfully",
    data: result,
  });
});

const getMyApplication = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  const result = await SalonOwnerService.getMySalonOwnerApplication(userId);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "My salon owner application retrieved successfully",
    data: result,
  });
});

// Admin
const getAllApplications = catchAsync(async (req: Request, res: Response) => {
  const result = await SalonOwnerService.getAllApplications(req.query);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Salon owner applications retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

const getApplicationById = catchAsync(async (req: Request, res: Response) => {
  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;

  const result = await SalonOwnerService.getApplicationById(id);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Salon owner application retrieved successfully",
    data: result,
  });
});

const approveApplication = catchAsync(async (req: Request, res: Response) => {
  const adminUserId = req.user?.userId;

  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;

  const result = await SalonOwnerService.approveApplication(adminUserId, id);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Application approved successfully",
    data: result,
  });
});

const rejectApplication = catchAsync(async (req: Request, res: Response) => {
  const adminUserId = req.user?.userId;

  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;

  const result = await SalonOwnerService.rejectApplication(
    adminUserId,
    id,
    req.body
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Application rejected successfully",
    data: result,
  });
});

export const SalonOwnerController = {
  applySalonOwner,
  getMyApplication,
  getAllApplications,
  getApplicationById,
  approveApplication,
  rejectApplication,
};
