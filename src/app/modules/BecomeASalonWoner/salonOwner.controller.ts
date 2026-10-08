import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { SalonOwnerService } from "./salonOwner.service";
import { audit } from "../../utils/audit";

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
  await audit(req.auditCtx, {
    action: "application.approve",
    entityType: "owner_application",
    entityId: id,
    after: { applicationStatus: "APPROVED" },
    reason: req.body?.reason,
  });

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
  await audit(req.auditCtx, {
    action: "application.reject",
    entityType: "owner_application",
    entityId: id,
    after: { applicationStatus: "REJECTED", rejectionReason: req.body.rejectionReason },
    reason: req.body.reason ?? req.body.rejectionReason,
  });

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
