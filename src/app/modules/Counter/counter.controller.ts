import { Request, Response } from "express";
import catchAsync from "../../shared/catchAsync";
import { StatusCodes } from "http-status-codes";
import sendResponse from "../../shared/sendResponse";
import { CounterService } from "./counter.service";
import { assertAdminPermission } from "../Admin/admin.middleware";
import { withAccessCache } from "../../utils/salonAccess";

const createCounters = catchAsync(async (req: Request, res: Response) => {
  const result = await CounterService.createCounter(withAccessCache(req), req.body);

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: "Counter Created Successfully",
    data: result,
  });
});

const getAllCounters = catchAsync(async (req: Request, res: Response) => {
  await assertAdminPermission(req, "salons.view");
  const result = await CounterService.getAllCounters(withAccessCache(req), req.query);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Counters retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

const getCounterById = catchAsync(async (req: Request, res: Response) => {
  await assertAdminPermission(req, "salons.view");
  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;
  const result = await CounterService.getCounterById(withAccessCache(req), id);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Counter retrieved successfully",
    data: result,
  });
});

export const CounterController = {
  createCounters,
  getAllCounters,
  getCounterById,
};
