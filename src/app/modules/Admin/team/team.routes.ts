import express from "express";
import validateRequest from "../../../middlewares/validateRequest";
import { adminSensitiveLimiter } from "../../../middlewares/rateLimiter";
import { adminAuth, requireStepUp } from "../admin.middleware";
import { InvitationController } from "../invitations/invitation.controller";
import { InvitationValidation } from "../invitations/invitation.validation";
import { AdminTeamController } from "./team.controller";
import { AdminTeamValidation } from "./team.validation";

/** /admin/team - team.manage (SUPER_ADMIN only). Every write is tier 3. */
const router = express.Router();

router.use(adminAuth("team.manage"));

const tier3 = [adminSensitiveLimiter, requireStepUp()];

router.get("/", AdminTeamController.list);

router.post(
  "/invitations",
  validateRequest(InvitationValidation.inviteAdmin, { replaceBody: true }),
  ...tier3,
  InvitationController.inviteAdmin,
);
router.post("/invitations/:id/resend", ...tier3, AdminTeamController.resendInvitation);
router.post("/invitations/:id/revoke", ...tier3, AdminTeamController.revokeInvitation);

router.patch(
  "/:userId",
  validateRequest(AdminTeamValidation.changeRole, { replaceBody: true }),
  ...tier3,
  AdminTeamController.changeRole,
);
router.delete(
  "/:userId",
  validateRequest(AdminTeamValidation.withReason, { replaceBody: true }),
  ...tier3,
  AdminTeamController.remove,
);
router.post(
  "/:userId/reset-mfa",
  validateRequest(AdminTeamValidation.withReason, { replaceBody: true }),
  ...tier3,
  AdminTeamController.resetMfa,
);

export const AdminTeamRoutes = router;
