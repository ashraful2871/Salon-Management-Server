import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { toMinor } from "../../utils/money";
import { audit } from "../../utils/audit";
import { requireApprovalIf } from "../Admin/approvals/approvals.service";
import { SettlementEarnings } from "./settlement.earnings";
import { CommissionAdmin, SettlementService } from "./settlement.service";

const runPayoutBatch = catchAsync(async (req: Request, res: Response) => {
  const result = await SettlementService.runPayoutBatch({
    periodStart: req.body?.periodStart
      ? new Date(req.body.periodStart)
      : undefined,
    periodEnd: req.body?.periodEnd ? new Date(req.body.periodEnd) : undefined,
  }, {
    ctx: req.auditCtx,
    reason: req.body?.reason,
  });

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: `Payout batch complete: ${result.created.length} payout(s) raised`,
    data: result,
  });
});

const getAllPayouts = catchAsync(async (req: Request, res: Response) => {
  const result = await SettlementService.getAllPayouts(req.query);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Payouts retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

const updatePayoutStatus = catchAsync(async (req: Request, res: Response) => {
  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;

  const { reason, ...payload } = req.body;

  // Four-eyes: marking a payout paid always needs a second admin when on.
  if (
    payload.status === "PAID" &&
    (await requireApprovalIf(
      req,
      res,
      "payout.mark_paid",
      async () => {
        // Fail the obvious mistakes now rather than after someone approves.
        await SettlementService.assertPayable(id, payload);
        return true;
      },
      {
        payload: {
          payoutId: id,
          method: payload.method,
          reference: payload.reference,
          proofUrl: payload.proofUrl ?? null,
          reason: reason ?? null,
        },
        summary: `Mark payout ${id.slice(0, 8)} paid (${payload.method}, ref ${payload.reference})`,
        reason: reason || `Payout ${id} paid, ref ${payload.reference}`,
      },
    ))
  ) {
    return;
  }

  const result = await SettlementService.updatePayoutStatus(
    id,
    { ...payload, markedPaidById: req.user!.userId },
    { ctx: req.auditCtx, reason },
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Payout updated successfully",
    data: result,
  });
});

const getMyPayouts = catchAsync(async (req: Request, res: Response) => {
  const result = await SettlementService.getMyPayouts(
    req.user!.userId,
    req.query,
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Payouts retrieved successfully",
    meta: result.meta,
    data: { payouts: result.data, balances: result.balances },
  });
});

/** A salon owner's full earnings view: totals, payouts, balances, line items. */
const getMyEarnings = catchAsync(async (req: Request, res: Response) => {
  const result = await SettlementService.getMyEarnings(
    req.user!.userId,
    req.query,
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Earnings retrieved successfully",
    data: result,
  });
});

/** The platform's own earnings, for the admin dashboard. */
const getPlatformEarnings = catchAsync(async (_req: Request, res: Response) => {
  const result = await SettlementEarnings.getPlatformEarnings();

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Platform earnings retrieved successfully",
    data: result,
  });
});

const getSalonBalance = catchAsync(async (req: Request, res: Response) => {
  const salonIdParam = req.params.salonId;
  const salonId = Array.isArray(salonIdParam) ? salonIdParam[0] : salonIdParam;

  const result = await SettlementService.getSalonBalance(salonId);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Salon balance retrieved successfully",
    data: result,
  });
});

/** Every appointment's ledger entries must sum to zero. Anything here is a bug. */
const getLedgerAudit = catchAsync(async (_req: Request, res: Response) => {
  const unbalanced = await SettlementService.findUnbalancedAppointments();

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: unbalanced.length
      ? `${unbalanced.length} appointment(s) have unbalanced ledger entries`
      : "Every appointment's ledger entries balance",
    data: { unbalancedCount: unbalanced.length, appointments: unbalanced },
  });
});

// ---------------------------------------------------------------------------
// Commission rules. The API speaks taka; basis points are not money and pass
// through as they are.
// ---------------------------------------------------------------------------

const getCommissionRules = catchAsync(async (req: Request, res: Response) => {
  const result = await CommissionAdmin.getCommissionRules(req.query);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Commission rules retrieved successfully",
    data: result,
  });
});

const createCommissionRule = catchAsync(async (req: Request, res: Response) => {
  const { minAmount, maxAmount, flatFee, reason, ...rest } = req.body;

  const result = await CommissionAdmin.createCommissionRule({
    ...rest,
    minAmountMinor: minAmount === undefined ? undefined : toMinor(minAmount),
    maxAmountMinor: maxAmount === undefined ? null : toMinor(maxAmount),
    flatFeeMinor: flatFee === undefined ? null : toMinor(flatFee),
  });
  await audit(req.auditCtx, {
    action: "commission_rule.create",
    entityType: "commission_rule",
    entityId: result.id,
    salonId: result.salonId,
    after: result,
    reason,
  });

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: "Commission rule created successfully",
    data: result,
  });
});

const updateCommissionRule = catchAsync(async (req: Request, res: Response) => {
  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;

  const { minAmount, maxAmount, flatFee, reason, ...rest } = req.body;

  const result = await CommissionAdmin.updateCommissionRule(id, {
    ...rest,
    ...(minAmount !== undefined && { minAmountMinor: toMinor(minAmount) }),
    ...(maxAmount !== undefined && { maxAmountMinor: toMinor(maxAmount) }),
    ...(flatFee !== undefined && { flatFeeMinor: toMinor(flatFee) }),
  });
  await audit(req.auditCtx, {
    action: "commission_rule.update",
    entityType: "commission_rule",
    entityId: id,
    salonId: result.salonId,
    after: req.body,
    reason,
  });

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Commission rule updated successfully",
    data: result,
  });
});

export const SettlementController = {
  runPayoutBatch,
  getAllPayouts,
  updatePayoutStatus,
  getMyPayouts,
  getMyEarnings,
  getPlatformEarnings,
  getSalonBalance,
  getLedgerAudit,
  getCommissionRules,
  createCommissionRule,
  updateCommissionRule,
};
