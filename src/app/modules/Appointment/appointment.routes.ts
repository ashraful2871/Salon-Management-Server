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

// A walk-in or phone customer, entered at the counter. No deposit.
router.post(
  "/walk-in",
  auth(UserRole.SALON_OWNER, UserRole.STAFF),
  validateRequest(AppointmentValidation.walkInValidation),
  AppointmentController.bookWalkIn,
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

// These two must stay above GET "/:id", or Express reads "lookup" and
// "cash-summary" as appointment ids.
router.get(
  "/lookup",
  auth(UserRole.ADMIN, UserRole.SALON_OWNER, UserRole.STAFF),
  validateRequest(AppointmentValidation.lookupByTokenValidation),
  AppointmentController.lookupByToken,
);

router.get(
  "/cash-summary",
  auth(UserRole.ADMIN, UserRole.SALON_OWNER),
  validateRequest(AppointmentValidation.cashSummaryValidation),
  AppointmentController.cashSummary,
);

router.get(
  "/:id",
  auth(UserRole.ADMIN, UserRole.SALON_OWNER, UserRole.STAFF, UserRole.CUSTOMER),
  AppointmentController.getAppointmentById,
);

router.patch(
  "/:id/check-in",
  auth(UserRole.ADMIN, UserRole.SALON_OWNER, UserRole.STAFF),
  AppointmentController.checkIn,
);

router.patch(
  "/:id/start",
  auth(UserRole.ADMIN, UserRole.SALON_OWNER, UserRole.STAFF),
  AppointmentController.startAppointment,
);

router.post(
  "/:id/checkout",
  auth(UserRole.ADMIN, UserRole.SALON_OWNER, UserRole.STAFF),
  validateRequest(AppointmentValidation.checkoutValidation),
  AppointmentController.checkout,
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
