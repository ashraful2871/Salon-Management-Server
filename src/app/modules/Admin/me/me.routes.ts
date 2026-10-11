import express from "express";
import { z } from "zod";
import validateRequest from "../../../middlewares/validateRequest";
import { adminSensitiveLimiter, otpLimiter } from "../../../middlewares/rateLimiter";
import { adminAuth, requireStepUp } from "../admin.middleware";
import { AdminMeController } from "./me.controller";

/**
 * /admin/mfa/* - mounted behind adminGate with "/mfa/" exempt from the 2FA
 * requirement, so an account can enrol. Recovery codes need 2FA (adminAuth)
 * and a fresh step-up.
 */
const router = express.Router();

const codeBody = z.object({
  body: z.object({
    code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"),
  }),
});

router.post("/setup", AdminMeController.setup);
router.post("/activate", otpLimiter, validateRequest(codeBody, { replaceBody: true }), AdminMeController.activate);
router.post("/step-up", otpLimiter, validateRequest(codeBody, { replaceBody: true }), AdminMeController.stepUp);
router.post(
  "/recovery-codes",
  adminAuth(),
  adminSensitiveLimiter,
  requireStepUp(),
  AdminMeController.regenerateRecoveryCodes,
);

export const AdminMfaRoutes = router;
