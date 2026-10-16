import express from "express";
import auth from "../../middlewares/auth";
import optionalAuth from "../../middlewares/optionalAuth";
import validateRequest from "../../middlewares/validateRequest";
import { authLimiter, teamInviteLimiter } from "../../middlewares/rateLimiter";
import { BUSINESS_ROLES } from "../../utils/salonAccess";
import { TeamController } from "./team.controller";
import { TeamValidation } from "./team.validation";

/**
 * Branch teams, mounted on the root router: /salons/:salonId/members|invitations
 * for the owner and managers, /invitations/* for the invitee. Who may do what
 * is decided in the service (team.invite at the branch; managers never touch
 * managers).
 */
const router = express.Router();

router.get("/invitations/preview", authLimiter, optionalAuth(), validateRequest(TeamValidation.preview), TeamController.preview);
router.post(
  "/invitations/accept",
  authLimiter,
  auth(),
  validateRequest(TeamValidation.accept, { replaceBody: true }),
  TeamController.accept,
);
router.post("/invitations/:id/resend", auth(...BUSINESS_ROLES), teamInviteLimiter, TeamController.resend);
router.delete("/invitations/:id", auth(...BUSINESS_ROLES), TeamController.revoke);

router.get("/salons/:salonId/members", auth(...BUSINESS_ROLES), TeamController.listMembers);
router.post("/salons/:salonId/members/leave", auth(...BUSINESS_ROLES), TeamController.leave);
router.patch(
  "/salons/:salonId/members/:memberId",
  auth(...BUSINESS_ROLES),
  validateRequest(TeamValidation.updateMember, { replaceBody: true }),
  TeamController.updateMember,
);
router.delete("/salons/:salonId/members/:memberId", auth(...BUSINESS_ROLES), TeamController.removeMember);

router.get("/salons/:salonId/invitations", auth(...BUSINESS_ROLES), TeamController.listInvitations);
router.post(
  "/salons/:salonId/invitations",
  auth(...BUSINESS_ROLES),
  teamInviteLimiter,
  validateRequest(TeamValidation.invite, { replaceBody: true }),
  TeamController.invite,
);

export const TeamRoutes = router;
