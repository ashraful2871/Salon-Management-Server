import express from "express";
import auth from "../../middlewares/auth";
import { adminAuth, adminOnly } from "../Admin/admin.middleware";
import validateRequest from "../../middlewares/validateRequest";
import { SalonOwnerController } from "./salonOwner.controller";
import { SalonOwnerValidation } from "./salonOwner.validation";
import { UserRole } from "@prisma/client";

const router = express.Router();

// Customer applies
router.post(
  "/apply",
  auth(UserRole.CUSTOMER),
  validateRequest(SalonOwnerValidation.applySalonOwnerValidation),
  SalonOwnerController.applySalonOwner,
);

// Customer checks application
router.get(
  "/me",
  auth(UserRole.CUSTOMER),
  SalonOwnerController.getMyApplication,
);

// Admin: list + single //
router.get(
  "/applications",
  adminAuth("salons.review"),
  adminOnly,
  SalonOwnerController.getAllApplications,
);
router.get(
  "/applications/:id",
  adminAuth("salons.review"),
  adminOnly,
  SalonOwnerController.getApplicationById,
);

// Admin: approve/reject
router.patch(
  "/applications/:id/approve",
  adminAuth("salons.review"),
  adminOnly,
  validateRequest(SalonOwnerValidation.approveSalonOwnerValidation),
  SalonOwnerController.approveApplication,
);

router.patch(
  "/applications/:id/reject",
  adminAuth("salons.review"),
  adminOnly,
  validateRequest(SalonOwnerValidation.rejectSalonOwnerValidation),
  SalonOwnerController.rejectApplication,
);

export const SalonOwnerRoutes = router;
