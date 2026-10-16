import express from "express";
import { UserRole } from "@prisma/client";
import { StaffController } from "./staff.controller";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { StaffValidation } from "./staff.validation";
import { BUSINESS_ROLES } from "../../utils/salonAccess";

const router = express.Router();

// Hours and time off: staff.manage (owner + manager), checked in the service.
const SCHEDULE_ROLES = [UserRole.SALON_OWNER, UserRole.BRANCH_MANAGER] as const;

router.post(
  "/",
  auth(...BUSINESS_ROLES),
  validateRequest(StaffValidation.addStaffValidation),
  StaffController.addStaff
);

router.get("/", StaffController.getAllStaff);

// Who can take a booking (assign picker). Before "/:id".
router.get(
  "/availability",
  auth(...BUSINESS_ROLES),
  validateRequest(StaffValidation.availabilityValidation),
  StaffController.getAvailability
);

router.get("/:id/shifts", auth(...SCHEDULE_ROLES), StaffController.getShifts);
router.put(
  "/:id/shifts",
  auth(...SCHEDULE_ROLES),
  validateRequest(StaffValidation.putShiftsValidation),
  StaffController.putShifts
);
router.get("/:id/time-off", auth(...SCHEDULE_ROLES), StaffController.listTimeOff);
router.post(
  "/:id/time-off",
  auth(...SCHEDULE_ROLES),
  validateRequest(StaffValidation.addTimeOffValidation),
  StaffController.addTimeOff
);
router.delete("/:id/time-off/:timeOffId", auth(...SCHEDULE_ROLES), StaffController.deleteTimeOff);

router.get("/:id", StaffController.getStaffById);

router.patch(
  "/:id",
  auth(...BUSINESS_ROLES),
  validateRequest(StaffValidation.updateStaffValidation),
  StaffController.updateStaff
);

router.delete("/:id", auth(...BUSINESS_ROLES), StaffController.removeStaff);

export const StaffRoutes = router;
