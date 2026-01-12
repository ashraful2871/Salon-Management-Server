import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { SalonService } from "./salon.service";

const createSalon = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId;

  const result = await SalonService.createSalon(userId, req.body);

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: "Salon created successfully",
    data: result,
  });
});

const getAllSalons = catchAsync(async (req: Request, res: Response) => {
  const result = await SalonService.getAllSalons(req.query);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Salons retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

const getMySalons = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId;

  const result = await SalonService.getMySalons(userId, req.query);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "My salons retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

const getSalonById = catchAsync(async (req: Request, res: Response) => {
  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;
  const result = await SalonService.getSalonById(id);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Salon retrieved successfully",
    data: result,
  });
});

const updateSalon = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;

  const result = await SalonService.updateSalon(userId, id, req.body);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Salon updated successfully",
    data: result,
  });
});

const updateSalonStatus = catchAsync(async (req: Request, res: Response) => {
  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;
  const result = await SalonService.updateSalonStatus(id, req.body.status);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Salon status updated successfully",
    data: result,
  });
});

const deleteSalon = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  const userRole = req.user?.role;
  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;

  await SalonService.deleteSalon(userId, userRole, id);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Salon deleted successfully",
    data: null,
  });
});

export const SalonController = {
  createSalon,
  getAllSalons,
  getMySalons,
  getSalonById,
  updateSalon,
  updateSalonStatus,
  deleteSalon,
};
