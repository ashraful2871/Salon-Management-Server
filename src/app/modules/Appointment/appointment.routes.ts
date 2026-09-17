import express from "express";
import { AppointmentController } from "./appointment.controller";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { AppointmentValidation } from "./appointment.validation";
import { UserRole } from "@prisma/client";

const router = express.Router();

router.post(
  "/",
  auth("CUSTOMER"),
  validateRequest(AppointmentValidation.bookAppointmentValidation),
  AppointmentController.bookAppointment,
);

router.get(
  "/",
  auth(UserRole.ADMIN, UserRole.SALON_OWNER, UserRole.STAFF, UserRole.CUSTOMER),
  AppointmentController.getAllAppointments,
);

router.get(
  "/my-appointments",
  auth(UserRole.CUSTOMER),
  AppointmentController.getMyAppointments,
);

router.get(
  "/:id",
  auth(UserRole.ADMIN, UserRole.SALON_OWNER, UserRole.STAFF, UserRole.CUSTOMER),
  AppointmentController.getAppointmentById,
);

router.patch(
  "/:id/status",
  auth(UserRole.ADMIN, UserRole.SALON_OWNER, UserRole.STAFF, UserRole.CUSTOMER),
  validateRequest(AppointmentValidation.updateAppointmentStatusValidation),
  AppointmentController.updateAppointmentStatus,
);

router.get(
  "/:id/cancellation-preview",
  auth(UserRole.CUSTOMER),
  AppointmentController.getCancellationPreview,
);

// A forfeited deposit is appealable for 48 hours. Publishing that is what
// stops the no-show mechanic feeling arbitrary.
router.post(
  "/:id/appeal",
  auth(UserRole.CUSTOMER),
  validateRequest(AppointmentValidation.appealNoShowValidation),
  AppointmentController.appealNoShow,
);

router.patch(
  "/:id/appeal",
  auth(UserRole.ADMIN),
  validateRequest(AppointmentValidation.resolveAppealValidation),
  AppointmentController.resolveAppeal,
);

router.delete(
  "/:id",
  auth(UserRole.CUSTOMER, UserRole.SALON_OWNER),
  AppointmentController.cancelAppointment,
);

export const AppointmentRoutes = router;
