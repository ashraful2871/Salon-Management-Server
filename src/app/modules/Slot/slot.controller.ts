import { Request, Response } from "express";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { StatusCodes } from "http-status-codes";
import { SlotService } from "./slot.service";

const bulkCreateSlots = catchAsync(async (req: Request, res: Response) => {
  const user = (req as any).user;
  const result = await SlotService.bulkCreateSlots(user.userId, user.role, req.body);

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: "Slots generated successfully!",
    data: result,
  });
});

const getSlots = catchAsync(async (req: Request, res: Response) => {
  const result = await SlotService.getSlots(req.query);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Slots retrieved successfully!",
    data: result,
  });
});

const updateSlotStatus = catchAsync(async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { id } = req.params;
  const result = await SlotService.updateSlotStatus(user.userId, user.role, id, req.body);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Slot status updated successfully!",
    data: result,
  });
});

const deleteSlot = catchAsync(async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { id } = req.params;
  const result = await SlotService.deleteSlot(user.userId, user.role, id);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Slot deleted successfully!",
    data: result,
  });
});

export const SlotController = {
  bulkCreateSlots,
  getSlots,
  updateSlotStatus,
  deleteSlot,
};
