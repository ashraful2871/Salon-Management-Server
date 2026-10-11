import express from "express";
import validateRequest from "../../../middlewares/validateRequest";
import { adminSensitiveLimiter } from "../../../middlewares/rateLimiter";
import { adminAuth, requireStepUp } from "../admin.middleware";
import { AdminUsersController } from "./users.controller";
import { AdminUsersValidation } from "./users.validation";

/** /admin/users - mounted behind the /admin gate (2FA + profile). */
const router = express.Router();

router.get("/", adminAuth("users.view"), validateRequest(AdminUsersValidation.list), AdminUsersController.list);
router.get("/:id", adminAuth("users.view"), AdminUsersController.get);
router.get("/:id/bookings", adminAuth("users.view"), AdminUsersController.bookings);
router.get("/:id/wallet", adminAuth("users.view", "finance.view"), AdminUsersController.wallet);
router.get("/:id/reviews", adminAuth("users.view"), AdminUsersController.reviews);
router.get("/:id/activity", adminAuth("users.view"), AdminUsersController.activity);
router.get("/:id/impact", adminAuth("users.manage"), AdminUsersController.impact);

// Tier 2: reason code required.
router.patch(
  "/:id/status",
  adminAuth("users.manage"),
  validateRequest(AdminUsersValidation.updateStatus, { replaceBody: true }),
  AdminUsersController.updateStatus,
);
// Tier 1.
router.post(
  "/:id/revoke-sessions",
  adminAuth("users.manage"),
  validateRequest(AdminUsersValidation.optionalReason, { replaceBody: true }),
  AdminUsersController.revokeSessions,
);

// Tier 3: step-up, sensitive limiter, audit inside the transaction.
router.post(
  "/:id/verify-email",
  adminAuth("users.manage"),
  validateRequest(AdminUsersValidation.withReason, { replaceBody: true }),
  adminSensitiveLimiter,
  requireStepUp(),
  AdminUsersController.verifyEmail,
);
router.patch(
  "/:id/role",
  adminAuth("users.role"),
  validateRequest(AdminUsersValidation.updateRole, { replaceBody: true }),
  adminSensitiveLimiter,
  requireStepUp(),
  AdminUsersController.updateRole,
);

// Privacy requests (users.delete, tier 3). The export is a JSON download
// relayed by the frontend export route; it opens the step-up window first.
router.get(
  "/:id/export",
  adminAuth("users.delete"),
  adminSensitiveLimiter,
  requireStepUp(),
  AdminUsersController.exportData,
);
router.post(
  "/:id/anonymize",
  adminAuth("users.delete"),
  validateRequest(AdminUsersValidation.anonymize, { replaceBody: true }),
  adminSensitiveLimiter,
  requireStepUp(),
  AdminUsersController.anonymize,
);

export const AdminUsersRoutes = router;
