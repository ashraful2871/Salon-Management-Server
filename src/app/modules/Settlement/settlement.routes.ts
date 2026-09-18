import express from "express";
import { UserRole } from "@prisma/client";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { SettlementController } from "./settlement.controller";
import { SettlementValidation } from "./settlement.validation";

const router = express.Router();

// A salon owner's own settlement view: what has been paid, and what is owed.
router.get(
  "/my-payouts",
  auth(UserRole.SALON_OWNER),
  SettlementController.getMyPayouts,
);

// The same money, with the derived totals and the bookings behind them. This is
// what the owner's Earnings screen reads.
router.get(
  "/my-earnings",
  auth(UserRole.SALON_OWNER),
  SettlementController.getMyEarnings,
);

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
router.get(
  "/platform-earnings",
  auth(UserRole.ADMIN),
  SettlementController.getPlatformEarnings,
);

router.get("/payouts", auth(UserRole.ADMIN), SettlementController.getAllPayouts);

router.post(
  "/payouts/run",
  auth(UserRole.ADMIN),
  validateRequest(SettlementValidation.runPayoutBatchValidation),
  SettlementController.runPayoutBatch,
);

router.patch(
  "/payouts/:id",
  auth(UserRole.ADMIN),
  validateRequest(SettlementValidation.updatePayoutStatusValidation),
  SettlementController.updatePayoutStatus,
);

router.get(
  "/balance/:salonId",
  auth(UserRole.ADMIN),
  SettlementController.getSalonBalance,
);

router.get(
  "/audit/unbalanced",
  auth(UserRole.ADMIN),
  SettlementController.getLedgerAudit,
);

router.get(
  "/commission-rules",
  auth(UserRole.ADMIN),
  SettlementController.getCommissionRules,
);

router.post(
  "/commission-rules",
  auth(UserRole.ADMIN),
  validateRequest(SettlementValidation.createCommissionRuleValidation),
  SettlementController.createCommissionRule,
);

router.patch(
  "/commission-rules/:id",
  auth(UserRole.ADMIN),
  validateRequest(SettlementValidation.updateCommissionRuleValidation),
  SettlementController.updateCommissionRule,
);

export const SettlementRoutes = router;
