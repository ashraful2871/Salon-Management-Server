import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { AppointmentService } from "./appointment.service";

const bookAppointment = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId;

  const result = await AppointmentService.bookAppointment(userId, req.body);

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: "Appointment booked successfully",
    data: result,
  });
});

const getAllAppointments = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  const userRole = req.user?.role;

  const result = await AppointmentService.getAllAppointments(
    userId,
    userRole,
    req.query
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Appointments retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

const getMyAppointments = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId;

  const result = await AppointmentService.getMyAppointments(userId, req.query);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "My appointments retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

const getAppointmentById = catchAsync(async (req: Request, res: Response) => {
  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;

  const result = await AppointmentService.getAppointmentById(id);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Appointment retrieved successfully",
    data: result,
  });
});

const updateAppointmentStatus = catchAsync(
  async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    const userRole = req.user?.role;
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;

    const result = await AppointmentService.updateAppointmentStatus(
      userId,
      userRole,
      id,
      req.body
    );

    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: "Appointment status updated successfully",
      data: result,
    });
  }
);

const cancelAppointment = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId;

  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;

  const result = await AppointmentService.cancelAppointment(userId, id);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Appointment cancelled successfully",
    data: result,
  });
});

/** Shown before the confirm button so a forfeit is never a surprise. */
const getCancellationPreview = catchAsync(
  async (req: Request, res: Response) => {
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;

    const result = await AppointmentService.getCancellationPreview(
      req.user!.userId,
      id,
    );

    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: "Cancellation preview retrieved successfully",
      data: result,
    });
  },
);

const appealNoShow = catchAsync(async (req: Request, res: Response) => {
  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;

  const result = await AppointmentService.appealNoShow(
    req.user!.userId,
    id,
    req.body.reason,
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Appeal submitted. An admin will review it shortly.",
    data: result,
  });
});

const resolveAppeal = catchAsync(async (req: Request, res: Response) => {
  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;

  const result = await AppointmentService.resolveAppeal(req.user!.userId, id, {
    approve: req.body.approve,
    note: req.body.note,
  });

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: req.body.approve
      ? "Appeal upheld and the deposit returned"
      : "Appeal rejected",
    data: result,
  });
});

export const AppointmentController = {
  bookAppointment,
  getAllAppointments,
  getMyAppointments,
  getAppointmentById,
  updateAppointmentStatus,
  cancelAppointment,
  getCancellationPreview,
  appealNoShow,
  resolveAppeal,
};
