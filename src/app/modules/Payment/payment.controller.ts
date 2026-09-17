import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import config from "../../../config";
import { PaymentService } from "./payment.service";
import { PaymentIntentService } from "./paymentIntent.service";

const createPayment = catchAsync(async (req: Request, res: Response) => {
  const result = await PaymentService.createPayment(
    req.user!.userId,
    req.user!.role,
    req.body,
  );

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: "Payment recorded successfully",
    data: result,
  });
});

const getAllPayments = catchAsync(async (req: Request, res: Response) => {
  const result = await PaymentService.getAllPayments(
    req.user!.userId,
    req.user!.role,
    req.query,
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Payments retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

const getPaymentById = catchAsync(async (req: Request, res: Response) => {
  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;
  const result = await PaymentService.getPaymentById(
    id,
    req.user!.userId,
    req.user!.role,
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Payment retrieved successfully",
    data: result,
  });
});

const updatePaymentStatus = catchAsync(async (req: Request, res: Response) => {
  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;
  const result = await PaymentService.updatePaymentStatus(
    id,
    req.user!.userId,
    req.user!.role,
    req.body,
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Payment status updated successfully",
    data: result,
  });
});

// ---------------------------------------------------------------------------
// SSLCommerz callbacks
// ---------------------------------------------------------------------------

const WALLET_PAGE = `${config.frontend_url}/dashboard/wallet`;

/**
 * The only endpoint that moves money in from the gateway.
 *
 * It answers 200 straight away and works afterwards: a non-200 makes
 * SSLCommerz retry the delivery indefinitely, and the work here can take a
 * round-trip to the validation API. Nothing is thrown out of the handler
 * because the response has already gone.
 */
const handleIpn = (req: Request, res: Response) => {
  res.status(StatusCodes.OK).json({ received: true });

  const payload = (req.body ?? {}) as Record<string, string>;

  void PaymentIntentService.processIpn(payload).catch((error) => {
    console.error(
      `[payment.ipn] processing failed for tran_id=${payload?.tran_id}`,
      error,
    );
  });
};

/**
 * Return routes. These only bounce the browser back to the frontend - they
 * never credit anything, because anyone can hand-craft a POST to this URL.
 * The wallet page polls `GET /wallet/topup/:transactionId` for the real state.
 */
const handleSuccessRedirect = (req: Request, res: Response) => {
  const payload = (req.body ?? {}) as Record<string, string>;
  
  // Attempt to process IPN immediately during the redirect so that 
  // localhost development works without ngrok, and real IPNs aren't the only 
  // way to confirm a payment.
  if (payload.tran_id) {
    void PaymentIntentService.processIpn(payload).catch((error) => {
      console.error(
        `[payment.success-redirect] processing failed for tran_id=${payload.tran_id}`,
        error,
      );
    });
  }

  const tranId = encodeURIComponent(String(payload.tran_id ?? ""));
  res.redirect(`${WALLET_PAGE}?topup=processing&tran=${tranId}`);
};

const handleFailRedirect = (_req: Request, res: Response) => {
  res.redirect(`${WALLET_PAGE}?topup=failed`);
};

const handleCancelRedirect = (_req: Request, res: Response) => {
  res.redirect(`${WALLET_PAGE}?topup=cancelled`);
};

const runReconciliation = catchAsync(async (_req: Request, res: Response) => {
  const result = await PaymentIntentService.reconcilePendingIntents();

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Reconciliation complete",
    data: result,
  });
});

export const PaymentController = {
  createPayment,
  getAllPayments,
  getPaymentById,
  updatePaymentStatus,
  handleIpn,
  handleSuccessRedirect,
  handleFailRedirect,
  handleCancelRedirect,
  runReconciliation,
};
