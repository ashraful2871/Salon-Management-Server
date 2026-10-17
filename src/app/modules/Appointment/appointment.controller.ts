import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { AppointmentCheckout } from "./appointment.checkout";
import { AppointmentRefund } from "./appointment.refund";
import { AppointmentService } from "./appointment.service";
import { AppointmentCalendar } from "./appointment.calendar";
import { buildAuditCtx } from "../Admin/admin.middleware";
import { isBusinessRole, withAccessCache } from "../../utils/salonAccess";
import prisma from "../../shared/prisma";
import { audit } from "../../utils/audit";
import { assertAdminPermission } from "../Admin/admin.middleware";
import type { Permission } from "../Admin/admin.permissions";

// These routes are shared with owners, staff and customers. An ADMIN caller
// additionally needs the permission; other roles keep their ownership checks.
const asAdmin = (req: Request, permission: Permission) =>
  assertAdminPermission(req, permission);

/**
 * Audits a booking write by an admin, or by the business (owner, manager,
 * receptionist, stylist) so the owner's Activity page can show who checked a
 * customer in. Customers are not audited. Never throws.
 */
const auditBookingWrite = async (
  req: Request,
  action: string,
  id: string,
  after: Record<string, unknown>,
  reason?: string | null,
) => {
  const role = req.user?.role;
  if (!req.admin && !(role && isBusinessRole(role))) return;
  const salonId =
    (await prisma.appointment.findUnique({ where: { id }, select: { salonId: true } }).catch(() => null))
      ?.salonId ?? null;
  await audit(req.admin ? req.auditCtx : buildAuditCtx(req, role!), {
    action,
    entityType: "booking",
    entityId: id,
    salonId,
    after,
    reason: reason ?? (typeof req.body?.reason === "string" ? req.body.reason : null),
  });
};

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
  await asAdmin(req, "bookings.view");
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
  await asAdmin(req, "bookings.view");
  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;

  const result = await AppointmentService.getAppointmentById(
    id,
    req.user!.userId,
    req.user!.role,
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Appointment retrieved successfully",
    data: result,
  });
});

const updateAppointmentStatus = catchAsync(
  async (req: Request, res: Response) => {
    await asAdmin(req, "bookings.manage");
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
    await auditBookingWrite(req, "booking.status_change", id, {
      status: req.body.status,
    });

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
  const userRole = req.user?.role;

  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;
  const reason =
    typeof req.body?.reason === "string" ? req.body.reason : undefined;

  const result = await AppointmentService.cancelAppointment(
    userId,
    userRole,
    id,
    reason,
  );
  await auditBookingWrite(req, "booking.cancel", id, { status: "CANCELLED" });

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
  await audit(req.auditCtx, {
    action: req.body.approve ? "appeal.approve" : "appeal.reject",
    entityType: "booking",
    entityId: id,
    after: { appealStatus: req.body.approve ? "APPROVED" : "REJECTED", note: req.body.note ?? null },
    reason: req.body.reason ?? req.body.note,
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

const idFromParams = (req: Request) => {
  const idParam = req.params.id;
  return Array.isArray(idParam) ? idParam[0] : idParam;
};

const actor = (req: Request) => ({
  userId: req.user!.userId,
  role: req.user!.role,
});

const bookWalkIn = catchAsync(async (req: Request, res: Response) => {
  const result = await AppointmentService.bookWalkIn(actor(req), req.body);
  await auditBookingWrite(req, "booking.walk_in", result.id, { status: result.status, serialNumber: result.serialNumber ?? null });

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: "Walk-in booked successfully",
    data: result,
  });
});

const lookupByToken = catchAsync(async (req: Request, res: Response) => {
  await asAdmin(req, "bookings.view");
  const result = await AppointmentCheckout.lookupByToken(
    actor(req),
    String(req.query.token ?? ""),
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Booking found",
    data: result,
  });
});

const checkIn = catchAsync(async (req: Request, res: Response) => {
  await asAdmin(req, "bookings.manage");
  const result = await AppointmentCheckout.checkIn(
    actor(req),
    idFromParams(req),
  );
  await auditBookingWrite(req, "booking.check_in", idFromParams(req), {
    status: "CHECKED_IN",
  });

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Checked in",
    data: result,
  });
});

const startAppointment = catchAsync(async (req: Request, res: Response) => {
  await asAdmin(req, "bookings.manage");
  const result = await AppointmentCheckout.start(actor(req), idFromParams(req));
  await auditBookingWrite(req, "booking.start", idFromParams(req), {
    status: "IN_PROGRESS",
  });

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Service started",
    data: result,
  });
});

/** Owner refunds a completed booking's in-app payment to the wallet (Phase 15). */
const refund = catchAsync(async (req: Request, res: Response) => {
  const result = await AppointmentRefund.refundCompleted(
    actor(req),
    idFromParams(req),
    { amountMinor: req.body.amountMinor, reason: req.body.reason },
  );
  await auditBookingWrite(
    req,
    "booking.refund",
    idFromParams(req),
    {
      refundedMinor: result.refundedMinor,
      totalRefundedMinor: result.totalRefundedMinor,
      commissionReturnedMinor: result.commissionReturnedMinor,
    },
    req.body.reason,
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Refunded to the customer's wallet",
    data: result,
  });
});

const checkout = catchAsync(async (req: Request, res: Response) => {
  await asAdmin(req, "bookings.manage");
  const result = await AppointmentCheckout.checkout(
    actor(req),
    idFromParams(req),
    {
      paymentMethod: req.body.paymentMethod,
      reference: req.body.reference,
      tipMinor: req.body.tipMinor,
      discountMinor: req.body.discountMinor,
      discountReason: req.body.discountReason,
    },
  );
  await auditBookingWrite(req, "booking.checkout", idFromParams(req), {
    status: "COMPLETED",
    paymentMethod: req.body.paymentMethod,
    reference: req.body.reference ?? null,
    tipMinor: result.tipMinor,
    discountMinor: result.discountMinor,
  });
  // A discount moves money away from the salon and the platform alike, so it
  // gets its own row with the reason the desk gave.
  if (result.discountMinor > 0 && result.discountApplied) {
    await auditBookingWrite(
      req,
      "booking.discount",
      idFromParams(req),
      {
        totalMinor: result.totalMinor,
        discountMinor: result.discountMinor,
        billableMinor: result.billableMinor,
      },
      result.discountReason,
    );
  }

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Payment recorded and booking completed",
    data: result,
  });
});

const cashSummary = catchAsync(async (req: Request, res: Response) => {
  await asAdmin(req, "finance.view");
  const salonId =
    typeof req.query.salonId === "string" && req.query.salonId
      ? req.query.salonId
      : undefined;

  const result = await AppointmentCheckout.cashSummary(actor(req), {
    date: String(req.query.date),
    salonId,
  });

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Cash summary retrieved successfully",
    data: result,
  });
});

const getCalendar = catchAsync(async (req: Request, res: Response) => {
  const result = await AppointmentCalendar.getCalendar(withAccessCache(req), req.query);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Calendar retrieved successfully",
    data: result,
  });
});

const reschedule = catchAsync(async (req: Request, res: Response) => {
  const result = await AppointmentCalendar.rescheduleAppointment(
    withAccessCache(req),
    buildAuditCtx(req, req.user!.role),
    req.params.id,
    req.body.slotId,
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Booking moved",
    data: result,
  });
});

export const AppointmentController = {
  getCalendar,
  reschedule,
  bookAppointment,
  bookWalkIn,
  getAllAppointments,
  getMyAppointments,
  getAppointmentById,
  updateAppointmentStatus,
  cancelAppointment,
  getCancellationPreview,
  appealNoShow,
  resolveAppeal,
  lookupByToken,
  checkIn,
  startAppointment,
  checkout,
  refund,
  cashSummary,
};
