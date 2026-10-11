import express from "express";
import validateRequest from "../../../middlewares/validateRequest";
import { adminSensitiveLimiter } from "../../../middlewares/rateLimiter";
import { adminAuth, adminOnly, requireStepUp } from "../admin.middleware";
import { AdminSalonsController } from "./salons.controller";
import { AdminSalonsValidation } from "./salons.validation";

/**
 * /admin/salons - mounted behind the /admin gate (2FA + profile). Agents get
 * the list and the overview, both scoped to their area, and approve/reject;
 * every other route is adminOnly.
 */
const router = express.Router();

router.get("/", adminAuth("salons.view"), validateRequest(AdminSalonsValidation.list), AdminSalonsController.list);
router.get("/:id", adminAuth("salons.view"), AdminSalonsController.get);
router.get("/:id/services", adminAuth("salons.view"), adminOnly, AdminSalonsController.services);
router.get("/:id/team", adminAuth("salons.view"), adminOnly, AdminSalonsController.team);
router.get("/:id/bookings", adminAuth("salons.view"), adminOnly, AdminSalonsController.bookings);
router.get("/:id/reviews", adminAuth("salons.view"), adminOnly, AdminSalonsController.reviews);
router.get("/:id/money", adminAuth("salons.view", "finance.view"), adminOnly, AdminSalonsController.money);
router.get("/:id/activity", adminAuth("salons.view"), adminOnly, AdminSalonsController.activity);
router.get("/:id/impact", adminAuth("salons.view"), adminOnly, AdminSalonsController.impact);

// Tier 1-2: salons.review or salons.manage depending on the status (service).
router.patch(
  "/:id/status",
  adminAuth("salons.view"),
  validateRequest(AdminSalonsValidation.updateStatus, { replaceBody: true }),
  AdminSalonsController.updateStatus,
);
// Tier 2.
router.patch(
  "/:id/location",
  adminAuth("salons.manage"),
  adminOnly,
  validateRequest(AdminSalonsValidation.updateLocation, { replaceBody: true }),
  AdminSalonsController.updateLocation,
);
router.patch(
  "/:id/listing",
  adminAuth("salons.manage"),
  adminOnly,
  validateRequest(AdminSalonsValidation.updateListing, { replaceBody: true }),
  AdminSalonsController.updateListing,
);
// Tier 1.
router.post("/:id/reindex", adminAuth("system.operate"), adminOnly, AdminSalonsController.reindex);

// Tier 3: step-up and the sensitive limiter.
router.post(
  "/:id/cancel-upcoming",
  adminAuth("salons.manage"),
  adminOnly,
  validateRequest(AdminSalonsValidation.withReason, { replaceBody: true }),
  adminSensitiveLimiter,
  requireStepUp(),
  AdminSalonsController.cancelUpcoming,
);
router.delete(
  "/:id",
  adminAuth("salons.delete"),
  adminOnly,
  validateRequest(AdminSalonsValidation.remove, { replaceBody: true }),
  adminSensitiveLimiter,
  requireStepUp(),
  AdminSalonsController.remove,
);

export const AdminSalonsRoutes = router;
