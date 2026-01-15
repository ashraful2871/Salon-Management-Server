import express from "express";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { SalonOwnerController } from "./salonOwner.controller";
import { SalonOwnerValidation } from "./salonOwner.validation";
import { UserRole } from "@prisma/client";

const router = express.Router();

// Customer applies
router.post(
  "/apply",
  auth(UserRole.CUSTOMER, UserRole.SALON_OWNER),
  validateRequest(SalonOwnerValidation.applySalonOwnerValidation),
  SalonOwnerController.applySalonOwner
);

// Customer checks application
router.get(
  "/me",
  auth(UserRole.CUSTOMER, UserRole.SALON_OWNER),
  SalonOwnerController.getMyApplication
);

// Admin: list + single
router.get(
  "/applications",
  auth(UserRole.ADMIN),
  SalonOwnerController.getAllApplications
);
router.get(
  "/applications/:id",
  auth(UserRole.ADMIN),
  SalonOwnerController.getApplicationById
);

// Admin: approve/reject
router.patch(
  "/applications/:id/approve",
  auth(UserRole.ADMIN),
  validateRequest(SalonOwnerValidation.approveSalonOwnerValidation),
  SalonOwnerController.approveApplication
);

router.patch(
  "/applications/:id/reject",
  auth(UserRole.ADMIN),
  validateRequest(SalonOwnerValidation.rejectSalonOwnerValidation),
  SalonOwnerController.rejectApplication
);

export const SalonOwnerRoutes = router;
