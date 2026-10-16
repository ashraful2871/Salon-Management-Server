import express from "express";
import { StaffController } from "./staff.controller";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { StaffValidation } from "./staff.validation";
import { BUSINESS_ROLES } from "../../utils/salonAccess";

const router = express.Router();

router.post(
  "/",
  auth(...BUSINESS_ROLES),
  validateRequest(StaffValidation.addStaffValidation),
  StaffController.addStaff
);

router.get("/", StaffController.getAllStaff);

router.get("/:id", StaffController.getStaffById);

router.patch(
  "/:id",
  auth(...BUSINESS_ROLES),
  validateRequest(StaffValidation.updateStaffValidation),
  StaffController.updateStaff
);

router.delete("/:id", auth(...BUSINESS_ROLES), StaffController.removeStaff);

export const StaffRoutes = router;
