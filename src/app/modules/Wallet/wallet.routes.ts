import express from "express";
import { UserRole } from "@prisma/client";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { paymentLimiter } from "../../middlewares/rateLimiter";
import { WalletController } from "./wallet.controller";
import { WalletValidation } from "./wallet.validation";

const router = express.Router();

const ANY_SIGNED_IN = [
  UserRole.CUSTOMER,
  UserRole.STAFF,
  UserRole.SALON_OWNER,
  UserRole.ADMIN,
  UserRole.AGENT,
] as const;

router.get("/me", auth(...ANY_SIGNED_IN), WalletController.getMyWallet);

router.get(
  "/me/transactions",
  auth(...ANY_SIGNED_IN),
  WalletController.getMyTransactions,
);

router.get("/me/topups", auth(...ANY_SIGNED_IN), WalletController.getMyTopups);

// Starting a top-up spends a gateway session, so it gets a tighter budget than
// an ordinary read.
router.post(
  "/topup",
  paymentLimiter,
  auth(...ANY_SIGNED_IN),
  validateRequest(WalletValidation.topupValidation),
  WalletController.initiateTopup,
);

router.get(
  "/topup/:transactionId",
  auth(...ANY_SIGNED_IN),
  WalletController.getTopupStatus,
);

/**
 * The admin credit/debit. This is also how the whole deposit flow is tested
 * before the gateway is live: credit a test customer, then book against it.
 */
router.post(
  "/admin/adjust",
  auth(UserRole.ADMIN),
  validateRequest(WalletValidation.adminAdjustValidation),
  WalletController.adminAdjust,
);

router.get("/admin/drift", auth(UserRole.ADMIN), WalletController.getDriftReport);

export const WalletRoutes = router;
