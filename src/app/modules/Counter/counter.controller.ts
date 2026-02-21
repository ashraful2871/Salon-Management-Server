import { Request, Response } from "express";
import catchAsync from "../../shared/catchAsync";
import { StatusCodes } from "http-status-codes";
import sendResponse from "../../shared/sendResponse";
import { CounterService } from "./counter.service";

const createCounters = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId;

  const result = await CounterService.createCounter(userId, req.body);

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: "Counter Created Successfully",
    data: result,
  });
});

export const CounterController = {
  createCounters,
};
