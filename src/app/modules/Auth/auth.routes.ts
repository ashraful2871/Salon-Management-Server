import express from "express";
import { AuthController } from "./auth.controller";
import validateRequest from "../../middlewares/validateRequest";
import { AuthValidation } from "./auth.validation";
import auth from "../../middlewares/auth";
import { authLimiter, otpLimiter } from "../../middlewares/rateLimiter";

const router = express.Router();

// These schemas normalise as they validate (trimmed, lower-cased email; phone
// without spaces or dashes; trimmed code), so the handler gets the parsed body.
const parsed = { replaceBody: true };

router.post(
  "/register",
  authLimiter,
  validateRequest(AuthValidation.registerValidation, parsed),
  AuthController.register,
);

router.post(
  "/login",
  authLimiter,
  validateRequest(AuthValidation.loginValidation, parsed),
  AuthController.login,
);

router.post(
  "/verify-otp",
  otpLimiter,
  validateRequest(AuthValidation.verifyOtpValidation, parsed),
  AuthController.verifyOtp,
);

router.post(
  "/resend-otp",
  otpLimiter,
  validateRequest(AuthValidation.resendOtpValidation, parsed),
  AuthController.resendOtp,
);

router.post("/logout", AuthController.logout);

router.post(
  "/refresh-token",
  validateRequest(AuthValidation.refreshTokenValidation),
  AuthController.refreshToken,
);

router.post(
  "/change-password",
  auth("CUSTOMER", "STAFF", "SALON_OWNER", "ADMIN"),
  validateRequest(AuthValidation.changePasswordValidation),
  AuthController.changePassword,
);

// Rate limited like login: the password in the body makes this a credential check.
router.post(
  "/change-email",
  authLimiter,
  auth("CUSTOMER", "STAFF", "SALON_OWNER", "ADMIN", "AGENT"),
  validateRequest(AuthValidation.changeEmailValidation, parsed),
  AuthController.changeEmail,
);

router.get(
  "/me",
  auth("CUSTOMER", "STAFF", "SALON_OWNER", "ADMIN", "AGENT"),
  AuthController.getMyProfile,
);

router.post(
  "/forgot-password",
  authLimiter,
  validateRequest(AuthValidation.forgotPasswordValidation, parsed),
  AuthController.forgotPassword,
);

router.post(
  "/reset-password",
  authLimiter,
  validateRequest(AuthValidation.resetPasswordValidation),
  AuthController.resetPassword,
);

router.post(
  "/verify-email",
  authLimiter,
  validateRequest(AuthValidation.verifyEmailValidation),
  AuthController.verifyEmail,
);

router.post(
  "/resend-verification",
  authLimiter,
  validateRequest(AuthValidation.resendVerificationValidation, parsed),
  AuthController.resendVerification,
);

router.get("/providers", AuthController.providers);

router.post(
  "/google/start",
  authLimiter,
  validateRequest(AuthValidation.googleStartValidation, parsed),
  AuthController.googleStart,
);

router.post(
  "/google/callback",
  authLimiter,
  validateRequest(AuthValidation.googleCallbackValidation, parsed),
  AuthController.googleCallback,
);

export const AuthRoutes = router;
