import express from "express";
import auth from "../../middlewares/auth";
import { paymentLimiter, payoutCodeLimiter } from "../../middlewares/rateLimiter";
import validateRequest from "../../middlewares/validateRequest";
import { BUSINESS_ROLES } from "../../utils/salonAccess";
import { OwnerController } from "./owner.controller";
import { customerNoteBody, OwnerCustomers } from "./owner.customers";
import { OwnerHome } from "./owner.home";
import { OwnerMoney } from "./owner.money";
import { OwnerPayoutAccount } from "./owner.payoutAccount";
import { OwnerReviews } from "./owner.reviews";
import { OwnerStatements } from "./owner.statements";
import { OwnerValidation } from "./owner.validation";

const router = express.Router();

router.get("/access", auth(...BUSINESS_ROLES), OwnerController.getAccess);
// Today v2: needs attention, today, setup, week, branches (reports.view scope).
router.get("/home", auth(...BUSINESS_ROLES), OwnerHome.home);

// Customers (customers.view scope); notes and tags are per business.
router.get("/customers", auth(...BUSINESS_ROLES), OwnerCustomers.list);
router.get("/customers/:customerId", auth(...BUSINESS_ROLES), OwnerCustomers.detail);
router.put(
  "/customers/:customerId/note",
  auth(...BUSINESS_ROLES),
  validateRequest(customerNoteBody, { replaceBody: true }),
  OwnerCustomers.note,
);
// Reviews of the branches in reviews.reply scope; replies go through /reviews/:id/reply.
router.get("/reviews", auth(...BUSINESS_ROLES), OwnerReviews.list);

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

// Money hub: the business owner only (assertOwnerOf in each).
router.get("/money/summary", auth("SALON_OWNER"), OwnerMoney.summary);
router.get("/money/transactions.csv", auth("SALON_OWNER"), OwnerMoney.transactionsCsv);
router.get("/money/transactions", auth("SALON_OWNER"), OwnerMoney.transactions);
router.get("/money/payouts", auth("SALON_OWNER"), OwnerMoney.payouts);
router.get("/money/payouts/:id", auth("SALON_OWNER"), OwnerMoney.payout);
// Statements and invoices: the business owner only; another business's id is 404.
router.get("/statements", auth("SALON_OWNER"), OwnerStatements.list);
router.get("/statements/:id.csv", auth("SALON_OWNER"), OwnerStatements.csv);
router.get("/statements/:id", auth("SALON_OWNER"), OwnerStatements.detail);
router.post("/dues/pay", auth("SALON_OWNER"), paymentLimiter, OwnerMoney.payDues);

export const OwnerRoutes = router;
