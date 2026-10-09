import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { clientIp } from "../../middlewares/rateLimiter";
import { HairTryOnService } from "./hairTryOn.service";

const ownerToken = (req: Request) => req.get("x-tryon-token")?.trim();

const getStyles = catchAsync(async (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Hairstyles retrieved",
    data: await HairTryOnService.getStyles(),
  });
});

const createUpload = catchAsync(async (req: Request, res: Response) => {
  const result = await HairTryOnService.createUpload(
    req.body.turnstileToken,
    clientIp(req),
  );

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: "Upload ticket created",
    data: result,
  });
});

const confirmUpload = catchAsync(async (req: Request, res: Response) => {
  const result = await HairTryOnService.confirmUpload(
    req.params.id,
    ownerToken(req),
    req.body.version,
    req.body.signature,
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Photo ready",
    data: result,
  });
});

const deleteUpload = catchAsync(async (req: Request, res: Response) => {
  await HairTryOnService.deleteUpload(req.params.id, ownerToken(req));

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Photo deleted",
  });
});

// Runs before the generation limiters: a repeat of a queued, running or finished
// job is answered here and never counts against the visitor.
const reuseJob = catchAsync(async (req: Request, res: Response, next) => {
  const job = await HairTryOnService.findReusableJob(req.body, ownerToken(req));
  if (!job) return next();

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Try-on found",
    data: job,
  });
});

const createJob = catchAsync(async (req: Request, res: Response) => {
  const result = await HairTryOnService.createJob(req.body, ownerToken(req));

  sendResponse(res, {
    statusCode: StatusCodes.ACCEPTED,
    success: true,
    message: "Try-on started",
    data: result,
  });
});

const getJob = catchAsync(async (req: Request, res: Response) => {
  const result = await HairTryOnService.getJob(req.params.id, ownerToken(req));

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Try-on status",
    data: result,
  });
});

export const HairTryOnController = {
  getStyles,
  createUpload,
  confirmUpload,
  deleteUpload,
  reuseJob,
  createJob,
  getJob,
};
