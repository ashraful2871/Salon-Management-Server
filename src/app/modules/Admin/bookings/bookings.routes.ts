import express from "express";
import validateRequest from "../../../middlewares/validateRequest";
import { adminAuth, adminOnly } from "../admin.middleware";
import { AdminBookingsController } from "./bookings.controller";
import { AdminBookingsValidation } from "./bookings.validation";

/**
 * /admin/bookings - mounted behind the /admin gate (2FA + profile). Admins
 * only: bookings are not area-scoped, so agents get none of it.
 */
const router = express.Router();

router.get(
  "/",
  adminAuth("bookings.view"),
  adminOnly,
  validateRequest(AdminBookingsValidation.list),
  AdminBookingsController.list,
);
router.get("/:id", adminAuth("bookings.view"), adminOnly, AdminBookingsController.get);

// Tier 2.
router.post(
  "/:id/cancel",
  adminAuth("bookings.manage"),
  adminOnly,
  validateRequest(AdminBookingsValidation.cancel, { replaceBody: true }),
  AdminBookingsController.cancel,
);
router.post(
  "/:id/reverse-no-show",
  adminAuth("appeals.resolve"),
  adminOnly,
  validateRequest(AdminBookingsValidation.reverseNoShow, { replaceBody: true }),
  AdminBookingsController.reverseNoShow,
);

export const AdminBookingsRoutes = router;
