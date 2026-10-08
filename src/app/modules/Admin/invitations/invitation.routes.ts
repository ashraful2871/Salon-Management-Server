import express from "express";
import auth from "../../../middlewares/auth";
import optionalAuth from "../../../middlewares/optionalAuth";
import validateRequest from "../../../middlewares/validateRequest";
import { authLimiter } from "../../../middlewares/rateLimiter";
import { InvitationController } from "./invitation.controller";
import { InvitationValidation } from "./invitation.validation";

/**
 * /invitations/admin/* - the invitee's side. Creating invitations lives under
 * /admin (team.manage, agents.manage).
 */
const router = express.Router();

router.get(
  "/admin/preview",
  authLimiter,
  optionalAuth(),
  validateRequest(InvitationValidation.preview),
  InvitationController.preview,
);

router.post(
  "/admin/accept",
  authLimiter,
  auth(),
  validateRequest(InvitationValidation.accept, { replaceBody: true }),
  InvitationController.accept,
);

export const InvitationRoutes = router;
