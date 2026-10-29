import express from "express";
import auth from "../../middlewares/auth";
import optionalAuth from "../../middlewares/optionalAuth";
import { adminSensitiveLimiter, homePublicLimiter, paymentLimiter } from "../../middlewares/rateLimiter";
import validateRequest from "../../middlewares/validateRequest";
import { BUSINESS_ROLES } from "../../utils/salonAccess";
import { adminAuth, adminOnly, requireStepUp } from "../Admin/admin.middleware";
import { HomeController } from "./home.controller";
import { HomeValidation } from "./home.validation";

const router = express.Router();

// Public reads: guests can browse. optionalAuth first, so a test customer sees test salons.
const publicRead = [optionalAuth(), homePublicLimiter];
router.get("/catalog", ...publicRead, HomeController.publicCatalog);
router.get("/experts", ...publicRead, HomeController.publicExperts);
router.get("/experts/:id", ...publicRead, HomeController.publicExpert);
router.get("/availability", ...publicRead, HomeController.publicAvailability);
router.get("/availability/days", ...publicRead, HomeController.publicAvailabilityDays);

// Owner side. Settings and menu: homeservice.manage at the branch (salonAccess).
router.get("/owner/profile", auth(...BUSINESS_ROLES), validateRequest(HomeValidation.salonQuery), HomeController.getProfile);
router.put(
  "/owner/profile",
  auth(...BUSINESS_ROLES),
  validateRequest(HomeValidation.updateProfile, { replaceBody: true }),
  HomeController.updateProfile,
);

// On / off / pause: the business owner only (assertOwnerOf in each).
router.post(
  "/owner/profile/turn-on",
  auth("SALON_OWNER"),
  validateRequest(HomeValidation.turnOn, { replaceBody: true }),
  HomeController.turnOn,
);
router.post(
  "/owner/profile/turn-off",
  auth("SALON_OWNER"),
  validateRequest(HomeValidation.turnOff, { replaceBody: true }),
  HomeController.turnOff,
);
router.post(
  "/owner/profile/pause",
  auth("SALON_OWNER"),
  validateRequest(HomeValidation.pause, { replaceBody: true }),
  HomeController.pause,
);
router.post(
  "/owner/profile/resume",
  auth("SALON_OWNER"),
  validateRequest(HomeValidation.resume, { replaceBody: true }),
  HomeController.resume,
);

// Ladies / Gents menu.
router.get("/owner/offerings", auth(...BUSINESS_ROLES), validateRequest(HomeValidation.listOfferings), HomeController.listOfferings);
router.post(
  "/owner/offerings",
  auth(...BUSINESS_ROLES),
  validateRequest(HomeValidation.createOffering, { replaceBody: true }),
  HomeController.createOffering,
);
router.patch(
  "/owner/offerings/:id",
  auth(...BUSINESS_ROLES),
  validateRequest(HomeValidation.updateOffering, { replaceBody: true }),
  HomeController.updateOffering,
);
router.post(
  "/owner/offerings/:id/toggle",
  auth(...BUSINESS_ROLES),
  validateRequest(HomeValidation.offeringId),
  HomeController.toggleOffering,
);
router.delete(
  "/owner/offerings/:id",
  auth(...BUSINESS_ROLES),
  validateRequest(HomeValidation.offeringId),
  HomeController.deleteOffering,
);

// Experts: homeservice.manage at the branch.
router.get("/owner/experts", auth(...BUSINESS_ROLES), validateRequest(HomeValidation.salonQuery), HomeController.listExperts);
router.get(
  "/owner/experts/candidates",
  auth(...BUSINESS_ROLES),
  validateRequest(HomeValidation.salonQuery),
  HomeController.listCandidates,
);
router.post(
  "/owner/experts",
  auth(...BUSINESS_ROLES),
  validateRequest(HomeValidation.createExpert, { replaceBody: true }),
  HomeController.createExpert,
);
router.patch(
  "/owner/experts/:id",
  auth(...BUSINESS_ROLES),
  validateRequest(HomeValidation.updateExpert, { replaceBody: true }),
  HomeController.updateExpert,
);
router.put(
  "/owner/experts/:id/offerings",
  auth(...BUSINESS_ROLES),
  validateRequest(HomeValidation.expertOfferings, { replaceBody: true }),
  HomeController.setExpertOfferings,
);
router.post(
  "/owner/experts/:id/doc-upload-signature",
  auth(...BUSINESS_ROLES),
  validateRequest(HomeValidation.docSignature, { replaceBody: true }),
  HomeController.docUploadSignature,
);
router.post(
  "/owner/experts/:id/docs",
  auth(...BUSINESS_ROLES),
  validateRequest(HomeValidation.expertDoc, { replaceBody: true }),
  HomeController.saveExpertDoc,
);
router.post(
  "/owner/experts/:id/submit",
  auth(...BUSINESS_ROLES),
  validateRequest(HomeValidation.expertId),
  HomeController.submitExpert,
);
router.delete(
  "/owner/experts/:id",
  auth(...BUSINESS_ROLES),
  validateRequest(HomeValidation.removeExpert),
  HomeController.removeExpert,
);

// Customer bookings. Any signed-in account reaches the service, which answers
// a non-customer with HOME_SERVICE_CUSTOMER_ONLY (a bare role gate would
// give a codeless "Forbidden!").
router.post("/bookings/quote", auth(), homePublicLimiter, validateRequest(HomeValidation.quote, { replaceBody: true }), HomeController.quote);
router.post(
  "/bookings",
  auth(),
  homePublicLimiter,
  validateRequest(HomeValidation.createBooking, { replaceBody: true }),
  HomeController.createBooking,
);
router.get("/bookings/me", auth(), validateRequest(HomeValidation.myBookings), HomeController.myBookings);
router.get("/bookings/:id", auth(), validateRequest(HomeValidation.bookingId), HomeController.getBooking);
router.post(
  "/bookings/:id/pay",
  auth(),
  paymentLimiter,
  validateRequest(HomeValidation.payBooking, { replaceBody: true }),
  HomeController.payBooking,
);

export const HomeServiceRoutes = router;

// ---------------------------------------------------------------------------
// Back office, mounted at /admin/home-service inside the /admin gate.
// Every write is tier 3 (step-up + the sensitive limiter).
// ---------------------------------------------------------------------------

const admin = express.Router();
const tier3 = [adminSensitiveLimiter, requireStepUp()];

admin.get("/profiles", adminAuth("homeservice.view"), adminOnly, validateRequest(HomeValidation.adminProfiles), HomeController.adminProfiles);
admin.post(
  "/profiles/:id/approve",
  adminAuth("homeservice.manage"),
  adminOnly,
  validateRequest(HomeValidation.adminOptionalReason, { replaceBody: true }),
  ...tier3,
  HomeController.adminApproveProfile,
);
admin.post(
  "/profiles/:id/reject",
  adminAuth("homeservice.manage"),
  adminOnly,
  validateRequest(HomeValidation.adminWithReason, { replaceBody: true }),
  ...tier3,
  HomeController.adminRejectProfile,
);
admin.post(
  "/profiles/:id/suspend",
  adminAuth("homeservice.manage"),
  adminOnly,
  validateRequest(HomeValidation.adminWithReason, { replaceBody: true }),
  ...tier3,
  HomeController.adminSuspendProfile,
);
admin.post(
  "/profiles/:id/unsuspend",
  adminAuth("homeservice.manage"),
  adminOnly,
  validateRequest(HomeValidation.adminOptionalReason, { replaceBody: true }),
  ...tier3,
  HomeController.adminUnsuspendProfile,
);

admin.get("/experts", adminAuth("homeservice.view"), adminOnly, validateRequest(HomeValidation.adminExperts), HomeController.adminExperts);
admin.get(
  "/experts/:id/documents",
  adminAuth("homeservice.experts_verify"),
  adminOnly,
  validateRequest(HomeValidation.expertId),
  ...tier3,
  HomeController.adminExpertDocuments,
);
admin.post(
  "/experts/:id/verify",
  adminAuth("homeservice.experts_verify"),
  adminOnly,
  validateRequest(HomeValidation.adminOptionalReason, { replaceBody: true }),
  ...tier3,
  HomeController.adminVerifyExpert,
);
admin.post(
  "/experts/:id/reject",
  adminAuth("homeservice.experts_verify"),
  adminOnly,
  validateRequest(HomeValidation.adminWithReason, { replaceBody: true }),
  ...tier3,
  HomeController.adminRejectExpert,
);
admin.post(
  "/experts/:id/suspend",
  adminAuth("homeservice.experts_verify"),
  adminOnly,
  validateRequest(HomeValidation.adminWithReason, { replaceBody: true }),
  ...tier3,
  HomeController.adminSuspendExpert,
);
admin.post(
  "/experts/:id/gender",
  adminAuth("homeservice.experts_verify"),
  adminOnly,
  validateRequest(HomeValidation.adminExpertGender, { replaceBody: true }),
  ...tier3,
  HomeController.adminExpertGender,
);

export const HomeServiceAdminRoutes = admin;
