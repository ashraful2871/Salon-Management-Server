import express from "express";
import auth from "../../middlewares/auth";
import optionalAuth from "../../middlewares/optionalAuth";
import validateRequest from "../../middlewares/validateRequest";
import { referralLookupLimiter } from "../../middlewares/rateLimiter";
import { customerOnly, ReferralController } from "./referral.controller";
import { ReferralValidation } from "./referral.validation";

const router = express.Router();

// Public: the invite landing page. optionalAuth only to say "signed in".
router.get(
  "/code/:code",
  optionalAuth(),
  referralLookupLimiter,
  validateRequest(ReferralValidation.codeLookup),
  ReferralController.lookupCode,
);

// Any signed-in account reaches customerOnly, which answers non-customers
// with CUSTOMER_ONLY and a sentence rather than the role gate's bare 403.
router.get("/me", auth(), customerOnly, ReferralController.getMe);

router.get(
  "/me/friends",
  auth(),
  customerOnly,
  validateRequest(ReferralValidation.friendsQuery),
  ReferralController.getFriends,
);

router.get("/me/rewards/summary", auth(), customerOnly, ReferralController.getRewardsSummary);

router.get(
  "/me/rewards",
  auth(),
  customerOnly,
  validateRequest(ReferralValidation.rewardsQuery),
  ReferralController.getRewards,
);

export const ReferralRoutes = router;
