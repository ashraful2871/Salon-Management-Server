import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import config from "../../../config";
import { toMinor } from "../../utils/money";
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
 * Every return from the gateway lands on its own page, so the customer reads a
 * sentence written for what actually happened instead of a banner on the wallet
 * that has to guess. The transaction id rides along on all three: it is what
 * the page polls with, and what the customer quotes to support.
 */
const resultPage = (
  outcome: "success" | "failed" | "cancelled",
  tranId?: string,
) => {
  const url = `${WALLET_PAGE}/payment/${outcome}`;
  return tranId ? `${url}?tran=${encodeURIComponent(tranId)}` : url;
};

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
const gatewayPayload = (req: Request) => ({
  ...((req.query ?? {}) as Record<string, string>),
  ...((req.body ?? {}) as Record<string, string>),
});

const handleSuccessRedirect = (req: Request, res: Response) => {
  const payload = gatewayPayload(req);

  // Settle during the redirect as well as on the IPN, so localhost development
  // works without ngrok and the result page has something to show at once.
  if (payload.tran_id) {
    void PaymentIntentService.settleFromSuccessRedirect(payload).catch(
      (error) => {
        console.error(
          `[payment.success-redirect] processing failed for tran_id=${payload.tran_id}`,
          error,
        );
      },
    );
  }

  res.redirect(resultPage("success", payload.tran_id));
};

/**
 * The fail and cancel returns never write the intent off on the strength of
 * this request alone - anyone can POST here. They ask the gateway what really
 * happened; if that lookup fails the intent stays pending and the
 * reconciliation sweep picks it up.
 */
const handleFailRedirect = (req: Request, res: Response) => {
  const payload = gatewayPayload(req);

  if (payload.tran_id) {
    void PaymentIntentService.resolveByTransactionId(payload.tran_id).catch(
      (error) => {
        console.error(
          `[payment.fail-redirect] resolve failed for tran_id=${payload.tran_id}`,
          error,
        );
      },
    );
  }

  res.redirect(resultPage("failed", payload.tran_id));
};

const handleCancelRedirect = (req: Request, res: Response) => {
  const payload = gatewayPayload(req);

  if (payload.tran_id) {
    void PaymentIntentService.resolveByTransactionId(payload.tran_id).catch(
      (error) => {
        console.error(
          `[payment.cancel-redirect] resolve failed for tran_id=${payload.tran_id}`,
          error,
        );
      },
    );
  }

  res.redirect(resultPage("cancelled", payload.tran_id));
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

const refundTopup = catchAsync(async (req: Request, res: Response) => {
  const result = await PaymentIntentService.refundTopup(
    req.user!.userId,
    req.params.id,
    req.body.amount === undefined ? undefined : toMinor(req.body.amount),
    req.body.reason,
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message:
      result.status === "COMPLETED"
        ? "Refund sent"
        : "The gateway did not confirm the refund. Check it in the merchant portal before doing anything else.",
    data: result,
  });
});

/**
 * bKash returns the customer here (GET, occasionally POST). Not catchAsync:
 * whatever happens the browser has to land on a result page, never on a JSON
 * error.
 */
const handleBkashCallback = async (req: Request, res: Response) => {
  const params = { ...req.query, ...(req.body ?? {}) } as Record<string, unknown>;
  const paymentID = typeof params.paymentID === "string" ? params.paymentID : "";
  const status = typeof params.status === "string" ? params.status : "";

  try {
    const { outcome, transactionId } =
      await PaymentIntentService.settleBkashCallback(paymentID, status);
    res.redirect(resultPage(outcome, transactionId));
  } catch (error) {
    console.error("[payment.bkash] callback failed:", (error as Error).message);
    res.redirect(resultPage("failed"));
  }
};

const getPaymentMethods = catchAsync(async (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Payment methods retrieved successfully",
    data: PaymentIntentService.listPaymentMethods(),
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
  handleBkashCallback,
  getPaymentMethods,
  runReconciliation,
  refundTopup,
};
