import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { ReviewService } from "./review.service";

const createReview = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId;

  const result = await ReviewService.createReview(userId, req.body);

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: "Review created successfully",
    data: result,
  });
});

const getAllReviews = catchAsync(async (req: Request, res: Response) => {
  const result = await ReviewService.getAllReviews(req.query);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Reviews retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

const getReviewById = catchAsync(async (req: Request, res: Response) => {
  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;
  const result = await ReviewService.getReviewById(id);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Review retrieved successfully",
    data: result,
  });
});

const getReviewsBySalonId = catchAsync(async (req: Request, res: Response) => {
  const salonId = req.params.salonId;
  const result = await ReviewService.getReviewsBySalonId(salonId, req.query);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Salon reviews retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

const getReviewsByStaffId = catchAsync(async (req: Request, res: Response) => {
  const staffId = req.params.staffId;
  const result = await ReviewService.getReviewsByStaffId(staffId, req.query);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Staff reviews retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

export const ReviewController = {
  createReview,
  getAllReviews,
  getReviewById,
  getReviewsBySalonId,
  getReviewsByStaffId,
};
