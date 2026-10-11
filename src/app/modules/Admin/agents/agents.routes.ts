import express from "express";
import validateRequest from "../../../middlewares/validateRequest";
import { adminAuth, adminOnly } from "../admin.middleware";
import { InvitationController } from "../invitations/invitation.controller";
import { InvitationValidation } from "../invitations/invitation.validation";
import { AdminAgentsController } from "./agents.controller";
import { AdminAgentsValidation } from "./agents.validation";

/** /admin/agents - agents.manage, admin accounts only. */
const router = express.Router();

router.use(adminAuth("agents.manage"), adminOnly);

router.get("/", AdminAgentsController.list);
router.post(
  "/invitations",
  validateRequest(InvitationValidation.inviteAgent, { replaceBody: true }),
  InvitationController.inviteAgent,
);
router.post("/invitations/:id/resend", AdminAgentsController.resendInvitation);
router.post("/invitations/:id/revoke", AdminAgentsController.revokeInvitation);

// Tier 2: reason required.
router.patch(
  "/:id",
  validateRequest(AdminAgentsValidation.updateArea, { replaceBody: true }),
  AdminAgentsController.updateArea,
);
router.patch(
  "/:id/status",
  validateRequest(AdminAgentsValidation.updateStatus, { replaceBody: true }),
  AdminAgentsController.updateStatus,
);

export const AdminAgentsRoutes = router;
