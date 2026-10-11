import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { getMyAccess, withAccessCache } from "../../utils/salonAccess";

/** Every branch the caller works at and what they may do there. */
const getAccess = catchAsync(async (req: Request, res: Response) => {
  const result = await getMyAccess(withAccessCache(req));

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Access retrieved successfully",
    data: result,
  });
});

export const OwnerController = {
  getAccess,
};
