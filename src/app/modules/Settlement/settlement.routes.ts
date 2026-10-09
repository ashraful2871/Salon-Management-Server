import express, { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { UserRole } from "@prisma/client";
import auth from "../../middlewares/auth";
import { adminAuth, requireStepUp } from "../Admin/admin.middleware";
import { adminSensitiveLimiter } from "../../middlewares/rateLimiter";
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
  adminAuth("finance.view"),
  SettlementController.getPlatformEarnings,
);

router.get("/payouts", adminAuth("finance.view"), SettlementController.getAllPayouts);

router.post(
  "/payouts/run",
  adminAuth("finance.payouts"),
  validateRequest(SettlementValidation.runPayoutBatchValidation),
  adminSensitiveLimiter,
  requireStepUp(),
  SettlementController.runPayoutBatch,
);

router.patch(
  "/payouts/:id",
  adminAuth("finance.payouts"),
  validateRequest(SettlementValidation.updatePayoutStatusValidation),
  adminSensitiveLimiter,
  requireStepUp(),
  SettlementController.updatePayoutStatus,
);

router.get(
  "/balance/:salonId",
  adminAuth("finance.view"),
  SettlementController.getSalonBalance,
);

router.get(
  "/audit/unbalanced",
  adminAuth("finance.view"),
  SettlementController.getLedgerAudit,
);

// Commission is the booking.commissionPercent platform setting now. The table
// and its service code stay until the cleanup; every route answers 410.
const commissionRulesGone = (_req: Request, res: Response) => {
  res.status(StatusCodes.GONE).json({
    success: false,
    message: "Commission is a platform setting now",
  });
};
router.all(["/commission-rules", "/commission-rules/:id"], commissionRulesGone);

export const SettlementRoutes = router;
