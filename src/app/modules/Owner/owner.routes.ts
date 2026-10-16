import express from "express";
import { z } from "zod";
import auth from "../../middlewares/auth";
import { paymentLimiter, payoutCodeLimiter } from "../../middlewares/rateLimiter";
import validateRequest from "../../middlewares/validateRequest";
import { BUSINESS_ROLES } from "../../utils/salonAccess";
import { OwnerController } from "./owner.controller";
import { bulkPriceBody, copyHoursBody, copyServicesBody, OwnerCatalogue } from "./owner.catalogue";
import { customerNoteBody, OwnerCustomers } from "./owner.customers";
import { OwnerHome } from "./owner.home";
import { OwnerMoney } from "./owner.money";
import { bookingEmailModeBody, markReadBody, OwnerNotifications, prefsBody } from "./owner.notifications";
import { OwnerActivity } from "./owner.activity";
import { OwnerPayoutAccount } from "./owner.payoutAccount";
import { OwnerReports } from "./owner.reports";
import { OwnerReviews } from "./owner.reviews";
import { OwnerStatements } from "./owner.statements";
import { OwnerTeam } from "./owner.team";
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

// Per-stylist figures (reports.view scope) + the payroll CSV.
router.get("/team/performance.csv", auth(...BUSINESS_ROLES), OwnerTeam.performanceCsv);
router.get("/team/performance", auth(...BUSINESS_ROLES), OwnerTeam.performance);
// Reports (reports.view scope; `money` answers owners only). ".csv" stays above.
router.get("/reports/:report.csv", auth(...BUSINESS_ROLES), OwnerReports.csv);
router.get("/reports/:report", auth(...BUSINESS_ROLES), OwnerReports.json);

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

// Multi-branch catalogue (owner only; every branch named must be the owner's).
router.post("/services/copy", auth("SALON_OWNER"), validateRequest(z.object({ body: copyServicesBody }), { replaceBody: true }), OwnerCatalogue.copyServices);
// ?dryRun=1 previews before/after per branch without writing.
router.patch("/services/bulk-price", auth("SALON_OWNER"), validateRequest(z.object({ body: bulkPriceBody }), { replaceBody: true }), OwnerCatalogue.bulkPrice);
router.post("/salons/copy-hours", auth("SALON_OWNER"), validateRequest(z.object({ body: copyHoursBody }), { replaceBody: true }), OwnerCatalogue.copyHours);
// Profile completeness (branch.profile scope). "completeness" stays above ":id".
router.get("/salons/completeness", auth(...BUSINESS_ROLES), OwnerCatalogue.completenessList);
router.get("/salons/:id/completeness", auth(...BUSINESS_ROLES), OwnerCatalogue.completeness);

// The bell (every business account, own rows only) and its preferences.
router.get("/notifications", auth(...BUSINESS_ROLES), OwnerNotifications.list);
router.patch("/notifications/read", auth(...BUSINESS_ROLES), validateRequest(z.object({ body: markReadBody }), { replaceBody: true }), OwnerNotifications.markRead);
router.get("/notification-prefs", auth(...BUSINESS_ROLES), OwnerNotifications.getPrefs);
router.put("/notification-prefs", auth(...BUSINESS_ROLES), validateRequest(z.object({ body: prefsBody }), { replaceBody: true }), OwnerNotifications.putPrefs);
router.patch("/booking-email-mode", auth("SALON_OWNER"), validateRequest(z.object({ body: bookingEmailModeBody }), { replaceBody: true }), OwnerNotifications.setBookingEmailMode);
// Activity over the audit log (activity.view scope: owner all branches, manager theirs).
router.get("/activity", auth(...BUSINESS_ROLES), OwnerActivity.list);

export const OwnerRoutes = router;
