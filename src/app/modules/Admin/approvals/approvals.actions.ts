import { PayoutStatus, Prisma } from "@prisma/client";
import { AuditCtx } from "../../../utils/audit";
import { isSettingKey, setSetting, settingPermission } from "../../../utils/settings";
import { PaymentIntentService } from "../../Payment/paymentIntent.service";
import { SettlementService } from "../../Settlement/settlement.service";
import { WalletService } from "../../Wallet/wallet.service";
import { Permission } from "../admin.permissions";

/**
 * The four-eyes ACTIONS registry. Each entry runs **the same service function**
 * as the direct route, with the payload that route would have passed - an
 * approval only decides *when* it runs and who confirmed it.
 *
 * `transactional`: `execute` takes the approval's transaction, so the money
 * move and the EXECUTED stamp commit together. A refund calls the gateway, and
 * a setting write has its own audit, so those two run outside it.
 */
export type ApprovalRunCtx = {
  approvalId: string;
  requestedById: string;
  /** The approver's request context: they are the one who made it happen. */
  ctx: AuditCtx | undefined;
};

type ActionDef<P> = {
  permission: (payload: P) => Permission;
  transactional: boolean;
  execute: (payload: P, run: ApprovalRunCtx, tx?: Prisma.TransactionClient) => Promise<unknown>;
};

export type WalletAdjustPayload = { userId: string; amountMinor: number; reason: string };
export type TopupRefundPayload = { intentId: string; amountMinor: number | null; reason: string };
export type PayoutMarkPaidPayload = {
  payoutId: string;
  method: string;
  reference: string;
  proofUrl?: string | null;
  reason?: string | null;
};
export type SettingUpdatePayload = { key: string; value: unknown; reason: string };

const define = <P>(def: ActionDef<P>) => def;

export const ACTIONS = {
  "wallet.adjust": define<WalletAdjustPayload>({
    permission: () => "finance.wallet_adjust",
    transactional: true,
    execute: (p, run, tx) =>
      WalletService.adminAdjust(
        run.requestedById,
        {
          userId: p.userId,
          amountMinor: p.amountMinor,
          reason: p.reason,
          idempotencyKey: `admin-adjust:${run.approvalId}`,
        },
        run.ctx,
        tx,
      ),
  }),
  "topup.refund": define<TopupRefundPayload>({
    permission: () => "finance.refunds",
    transactional: false,
    execute: (p, run) =>
      PaymentIntentService.refundTopup(
        run.requestedById,
        p.intentId,
        p.amountMinor ?? undefined,
        p.reason,
        run.ctx,
      ),
  }),
  "payout.mark_paid": define<PayoutMarkPaidPayload>({
    permission: () => "finance.payouts",
    transactional: true,
    execute: (p, run, tx) =>
      SettlementService.updatePayoutStatus(
        p.payoutId,
        {
          status: PayoutStatus.PAID,
          method: p.method,
          reference: p.reference,
          proofUrl: p.proofUrl ?? undefined,
          markedPaidById: run.requestedById,
        },
        { ctx: run.ctx, reason: p.reason },
        tx,
      ),
  }),
  "setting.update": define<SettingUpdatePayload>({
    permission: (p) => (isSettingKey(p.key) ? settingPermission(p.key) : "settings.manage"),
    transactional: false,
    execute: (p, run) => {
      if (!isSettingKey(p.key)) throw new Error(`Unknown setting "${p.key}"`);
      return setSetting(p.key, p.value, run.ctx, p.reason);
    },
  }),
};

export type ApprovalAction = keyof typeof ACTIONS;

export const isApprovalAction = (action: string): action is ApprovalAction =>
  Object.prototype.hasOwnProperty.call(ACTIONS, action);

/** Registry lookup with the payload typed loosely: it came out of a Json column. */
export const actionDef = (action: ApprovalAction) =>
  ACTIONS[action] as unknown as ActionDef<Record<string, unknown>>;
