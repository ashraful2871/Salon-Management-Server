import express from "express";
import { UserRole } from "@prisma/client";
import { PaymentController } from "./payment.controller";
import { PaymentValidation } from "./payment.validation";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { paymentLimiter } from "../../middlewares/rateLimiter";

const router = express.Router();

// ---------------------------------------------------------------------------
// SSLCommerz callbacks. No auth(): the gateway has no JWT. The IPN is trusted
// only because of its signature and the independent validation call behind it,
// and the redirect routes deliberately do nothing but redirect.
// ---------------------------------------------------------------------------
router.post("/sslcz/ipn", PaymentController.handleIpn);
router.post("/sslcz/success", PaymentController.handleSuccessRedirect);
router.post("/sslcz/fail", PaymentController.handleFailRedirect);
router.post("/sslcz/cancel", PaymentController.handleCancelRedirect);

// Some gateway configurations return the customer with a GET.
router.get("/sslcz/success", PaymentController.handleSuccessRedirect);
router.get("/sslcz/fail", PaymentController.handleFailRedirect);
router.get("/sslcz/cancel", PaymentController.handleCancelRedirect);

router.post(
  "/admin/reconcile",
  auth(UserRole.ADMIN),
  PaymentController.runReconciliation,
);

// ---------------------------------------------------------------------------
// Counter payments
// ---------------------------------------------------------------------------
router.post(
  "/",
  // CUSTOMER is intentionally absent: a customer marking themselves paid was
  // the original hole here.
  auth(UserRole.ADMIN, UserRole.SALON_OWNER),
  // After auth: the limiter counts per account.
  paymentLimiter,
  validateRequest(PaymentValidation.createPaymentValidation),
  PaymentController.createPayment,
);

router.get(
  "/",
  auth(UserRole.ADMIN, UserRole.SALON_OWNER),
  PaymentController.getAllPayments,
);

router.get(
  "/:id",
  auth(UserRole.ADMIN, UserRole.SALON_OWNER, UserRole.CUSTOMER),
  PaymentController.getPaymentById,
);

router.patch(
  "/:id/status",
  auth(UserRole.ADMIN, UserRole.SALON_OWNER),
  validateRequest(PaymentValidation.updatePaymentStatusValidation),
  PaymentController.updatePaymentStatus,
);

export const PaymentRoutes = router;
