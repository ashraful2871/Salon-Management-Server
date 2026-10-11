import express from "express";
import { SalonController } from "./salon.controller";
import auth from "../../middlewares/auth";
import { adminAuth } from "../Admin/admin.middleware";
import { AdminSalonsController } from "../Admin/salons/salons.controller";
import { AdminSalonsValidation } from "../Admin/salons/salons.validation";
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

// A salon that is not ACTIVE answers only its owner and ADMIN/AGENT.
router.get("/:id", optionalAuth(), SalonController.getSalonById);

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

// The same handler as PATCH /admin/salons/:id/status: salons.review or
// salons.manage depending on the status, checked in the service.
router.patch(
  "/:id/status",
  adminAuth("salons.view"),
  validateRequest(AdminSalonsValidation.updateStatus, { replaceBody: true }),
  AdminSalonsController.updateStatus,
);

// Owners only; admins delete through DELETE /admin/salons/:id.
router.delete("/:id", auth("SALON_OWNER"), SalonController.deleteSalon);

export const SalonRoutes = router;
