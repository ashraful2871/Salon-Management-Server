import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import { loadAdminContext } from "../admin.middleware";
import { AdminBookingsService } from "./bookings.service";

type Query = Record<string, string | undefined>;

const ok = (res: Response, message: string, result: { meta?: unknown; data: unknown }) =>
  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message,
    meta: result.meta as never,
    data: result.data,
  });

const list = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Bookings", await AdminBookingsService.listBookings(req.query as Query));
});

const get = catchAsync(async (req: Request, res: Response) => {
  const admin = await loadAdminContext(req);
  ok(res, "Booking", { data: await AdminBookingsService.getBooking(admin, req.params.id) });
});

const cancel = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Booking cancelled and the deposit returned", {
    data: await AdminBookingsService.cancelForCustomer(req.auditCtx, req.params.id, req.body),
  });
});

const reverseNoShow = catchAsync(async (req: Request, res: Response) => {
  const admin = await loadAdminContext(req);
  ok(res, "No-show reversed and the deposit returned", {
    data: await AdminBookingsService.reverseNoShow(admin, req.auditCtx, req.params.id, req.body.reason),
  });
});

export const AdminBookingsController = { list, get, cancel, reverseNoShow };
