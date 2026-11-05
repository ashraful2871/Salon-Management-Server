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
import { BUSINESS_ROLES } from "../../utils/salonAccess";

const router = express.Router();

router.post(
  "/",
  auth("SALON_OWNER"),
  validateRequest(SalonValidation.createSalonValidation),
  SalonController.createSalon,
);

router.get("/", optionalAuth(), SalonController.getAllSalons);

router.get("/my-salons", auth("SALON_OWNER", "BRANCH_MANAGER"), SalonController.getMySalons);

// Must stay above "/:id", or "map" is read as a salon id.
router.get("/map", mapLimiter, SalonController.getSalonMarkers);
// The areas that have a live salon, with counts and pin bounds (the list
// pages' location filter). Same budget as the map; answers are cached.
router.get("/areas", mapLimiter, SalonController.getSalonAreas);

// Signed direct-to-Cloudinary photo uploads. The URL is then saved through
// PATCH /salons/:id (or sent with POST /salons for a new salon).
router.post(
  "/photo-upload-signature",
  auth("SALON_OWNER"),
  SalonController.newSalonPhotoUploadSignature,
);
router.post(
  "/:id/photo-upload-signature",
  auth(...BUSINESS_ROLES),
  SalonController.photoUploadSignature,
);
// Uploads the owner discarded before saving: deleted from Cloudinary.
router.post(
  "/:id/photo-uploads/discard",
  auth(...BUSINESS_ROLES),
  validateRequest(SalonValidation.discardPhotoUploadsValidation),
  SalonController.discardPhotoUploads,
);

// A salon that is not ACTIVE answers only its owner and ADMIN/AGENT.
router.get("/:id", optionalAuth(), SalonController.getSalonById);

router.patch(
  "/:id",
  auth(...BUSINESS_ROLES),
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

// Holidays and special hours (slots.manage, checked in the service).
router.get("/:id/closures", auth(...BUSINESS_ROLES), SalonController.listClosures);
router.post(
  "/:id/closures",
  auth(...BUSINESS_ROLES),
  validateRequest(SalonValidation.createClosureValidation),
  SalonController.createClosure,
);
router.delete("/:id/closures/:closureId", auth(...BUSINESS_ROLES), SalonController.deleteClosure);

// The owner's own pause on online bookings; a DUES pause answers 409.
router.get("/:id/pause", auth("SALON_OWNER"), SalonController.getPause);
router.post(
  "/:id/pause",
  auth("SALON_OWNER"),
  validateRequest(SalonValidation.pauseValidation),
  SalonController.pauseSalon,
);
router.delete("/:id/pause", auth("SALON_OWNER"), SalonController.resumeSalon);

// Owners only; admins delete through DELETE /admin/salons/:id.
router.delete(
  "/:id",
  auth("SALON_OWNER"),
  validateRequest(SalonValidation.deleteSalonValidation),
  SalonController.deleteSalon,
);

export const SalonRoutes = router;
