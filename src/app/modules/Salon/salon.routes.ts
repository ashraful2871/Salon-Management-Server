import express from "express";
import { SalonController } from "./salon.controller";
import auth from "../../middlewares/auth";
import {
  adminAuth,
  adminSensitiveForStaff,
  requireStepUp,
} from "../Admin/admin.middleware";
import validateRequest from "../../middlewares/validateRequest";
import { SalonValidation } from "./salon.validation";

import optionalAuth from "../../middlewares/optionalAuth";
import { mapLimiter } from "../../middlewares/rateLimiter";

const router = express.Router();

router.post(
  "/",
  auth("SALON_OWNER"),
  validateRequest(SalonValidation.createSalonValidation),
  SalonController.createSalon,
);

router.get("/", optionalAuth(), SalonController.getAllSalons);

router.get("/my-salons", auth("SALON_OWNER"), SalonController.getMySalons);

// Must stay above "/:id", or "map" is read as a salon id.
router.get("/map", mapLimiter, SalonController.getSalonMarkers);

router.get("/:id", SalonController.getSalonById);

router.patch(
  "/:id",
  auth("SALON_OWNER"),
  validateRequest(SalonValidation.updateSalonValidation),
  SalonController.updateSalon,
);

router.patch(
  "/:id/location",
  auth("SALON_OWNER"),
  validateRequest(SalonValidation.updateSalonLocationValidation),
  SalonController.updateSalonLocation,
);

router.patch(
  "/:id/status",
  // salons.review or salons.manage depending on the status; checked in the service.
  adminAuth(),
  validateRequest(SalonValidation.updateSalonStatusValidation),
  SalonController.updateSalonStatus,
);

router.delete(
  "/:id",
  auth("SALON_OWNER", "ADMIN"),
  adminSensitiveForStaff,
  requireStepUp(),
  SalonController.deleteSalon,
);

export const SalonRoutes = router;
