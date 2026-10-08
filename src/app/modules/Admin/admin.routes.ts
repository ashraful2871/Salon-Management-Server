import express from "express";
import validateRequest from "../../middlewares/validateRequest";
import { adminLimiter } from "../../middlewares/rateLimiter";
import { adminAuth, adminGate, adminOnly } from "./admin.middleware";
import { AdminMfaRoutes } from "./me/me.routes";
import { AdminUsersRoutes } from "./users/users.routes";
import { AdminTeamRoutes } from "./team/team.routes";
import { AdminAgentsRoutes } from "./agents/agents.routes";
import { AdminAgentsController } from "./agents/agents.controller";
import { AdminController } from "./admin.controller";
import { AdminValidation } from "./admin.validation";

const router = express.Router();

// Every /admin route: an ADMIN or AGENT with a profile and 2FA enabled, then
// the per-account limiter. Routes below add the permissions they need. Only
// /me and /mfa/* answer before 2FA is set up (403 TWO_FACTOR_SETUP_REQUIRED).
router.use(adminGate({ mfaExempt: ["/me", "/mfa/"] }), adminLimiter);

router.get("/me", AdminController.getMe);
router.use("/mfa", AdminMfaRoutes);

// Users, agents and the admin team (invitations live under the last two).
router.use("/users", AdminUsersRoutes);
router.use("/agents", AdminAgentsRoutes);
router.use("/team", AdminTeamRoutes);
router.get("/areas", adminAuth("agents.manage"), adminOnly, AdminAgentsController.areas);

// Results and inbox items are filtered by the caller's permissions inside.
router.get("/search", validateRequest(AdminValidation.search), AdminController.search);
router.get("/inbox", AdminController.inbox);

// Notes check the entity type's *.view permission inside.
router.get("/notes", validateRequest(AdminValidation.listNotes), AdminController.listNotes);
router.post("/notes", validateRequest(AdminValidation.createNote), AdminController.createNote);
router.delete("/notes/:id", AdminController.deleteNote);

export const AdminRoutes = router;
