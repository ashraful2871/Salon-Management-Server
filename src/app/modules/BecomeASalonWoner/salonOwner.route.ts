import express from "express";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { SalonOwnerController } from "./salonOwner.controller";
import { SalonOwnerValidation } from "./salonOwner.validation";

const router = express.Router();

// Customer applies
router.post(
  "/apply",
  auth("CUSTOMER"),
  validateRequest(SalonOwnerValidation.applySalonOwnerValidation),
  SalonOwnerController.applySalonOwner
);

// Customer checks application
router.get(
  "/me",
  auth("CUSTOMER", "SALON_OWNER"),
  SalonOwnerController.getMyApplication
);

// Admin: list + single
router.get(
  "/applications",
  auth("ADMIN"),
  SalonOwnerController.getAllApplications
);
router.get(
  "/applications/:id",
  auth("ADMIN"),
  SalonOwnerController.getApplicationById
);

// Admin: approve/reject
router.patch(
  "/applications/:id/approve",
  auth("ADMIN"),
  validateRequest(SalonOwnerValidation.approveSalonOwnerValidation),
  SalonOwnerController.approveApplication
);

router.patch(
  "/applications/:id/reject",
  auth("ADMIN"),
  validateRequest(SalonOwnerValidation.rejectSalonOwnerValidation),
  SalonOwnerController.rejectApplication
);

export const SalonOwnerRoutes = router;
