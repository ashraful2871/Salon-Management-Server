import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { toMinor } from "../../utils/money";
import { WalletService } from "./wallet.service";
import { PaymentIntentService } from "../Payment/paymentIntent.service";

const getMyWallet = catchAsync(async (req: Request, res: Response) => {
  const result = await WalletService.getWalletSummary(req.user!.userId);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Wallet retrieved successfully",
    data: result,
  });
});

const getMyTransactions = catchAsync(async (req: Request, res: Response) => {
  const result = await WalletService.getMyTransactions(
    req.user!.userId,
    req.query,
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Wallet transactions retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

const initiateTopup = catchAsync(async (req: Request, res: Response) => {
  const result = await PaymentIntentService.initiateTopup(
    req.user!.userId,
    toMinor(req.body.amount),
  );

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: "Top-up session created. Redirect the customer to complete it.",
    data: result,
  });
});

/** Polled by the frontend after the gateway redirect - only the IPN credits. */
const getTopupStatus = catchAsync(async (req: Request, res: Response) => {
  const transactionId = String(req.params.transactionId);
  const result = await PaymentIntentService.getIntentStatus(
    req.user!.userId,
    transactionId,
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Payment status retrieved successfully",
    data: result,
  });
});

const getMyTopups = catchAsync(async (req: Request, res: Response) => {
  const result = await PaymentIntentService.getMyIntents(
    req.user!.userId,
    req.query,
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Top-ups retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

const adminAdjust = catchAsync(async (req: Request, res: Response) => {
  const result = await WalletService.adminAdjust(req.user!.userId, {
    userId: req.body.userId,
    amountMinor: toMinor(req.body.amount),
    reason: req.body.reason,
  });

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: "Wallet adjusted successfully",
    data: result,
  });
});

/** Proves `balance` still equals the sum of the ledger behind it. */
const getDriftReport = catchAsync(async (_req: Request, res: Response) => {
  const drifted = await WalletService.findDrift();

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: drifted.length
      ? `${drifted.length} wallet(s) disagree with their ledger`
      : "All wallets reconcile with their ledger",
    data: { driftedCount: drifted.length, wallets: drifted },
  });
});

export const WalletController = {
  getMyWallet,
  getMyTransactions,
  initiateTopup,
  getTopupStatus,
  getMyTopups,
  adminAdjust,
  getDriftReport,
};
