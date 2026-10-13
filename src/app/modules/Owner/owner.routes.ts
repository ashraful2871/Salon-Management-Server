import express from "express";
import auth from "../../middlewares/auth";
import { payoutCodeLimiter } from "../../middlewares/rateLimiter";
import validateRequest from "../../middlewares/validateRequest";
import { BUSINESS_ROLES } from "../../utils/salonAccess";
import { OwnerController } from "./owner.controller";
import { OwnerPayoutAccount } from "./owner.payoutAccount";
import { OwnerValidation } from "./owner.validation";

const router = express.Router();

router.get("/access", auth(...BUSINESS_ROLES), OwnerController.getAccess);

// Payout accounts and KYC: the business owner only (assertOwnerOf in each).
router.get("/payout-accounts", auth("SALON_OWNER"), OwnerPayoutAccount.list);
router.post(
  "/payout-accounts/code",
  auth("SALON_OWNER"),
  payoutCodeLimiter,
  OwnerPayoutAccount.sendCode,
);
router.post(
  "/payout-accounts",
  auth("SALON_OWNER"),
  validateRequest(OwnerValidation.addPayoutAccount, { replaceBody: true }),
  OwnerPayoutAccount.add,
);
router.patch(
  "/kyc",
  auth("SALON_OWNER"),
  validateRequest(OwnerValidation.updateKyc, { replaceBody: true }),
  OwnerPayoutAccount.updateKyc,
);

export const OwnerRoutes = router;
