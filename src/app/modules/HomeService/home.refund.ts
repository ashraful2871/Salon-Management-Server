import { AdvanceStatus, HomeBookingStatus, IntentPurpose, IntentStatus, PaymentIntent } from "@prisma/client";
import prisma from "../../shared/prisma";
import { systemAuditCtx } from "../../utils/audit";
import { ESCROW_DESCRIPTION, PaymentIntentService, type IntentRefundResult } from "../Payment/paymentIntent.service";

/**
 * Home visits are paid at bKash or SSLCommerz, never from the wallet. The
 * payment passes through the customer's wallet only as escrow: it is credited
 * and the advance is held from it in the same breath, so the ledger keeps
 * working, and the customer never sees or spends a balance.
 *
 * So whatever of that payment is not kept goes back to the account that paid,
 * through here: the part of the advance a cancellation or no-show returns, a
 * fee given back on appeal, a payment that arrived after its time ran out, a
 * second payment for the same visit, and a gateway minimum above the advance.
 *
 * `syncHomeRefund` is idempotent: it works out what the gateways should have
 * returned in total and refunds only the difference, under the per-payment
 * lock `refundIntent` takes. It runs right after each of those events and
 * from the `home.refunds` sweep, which catches a crash between the two.
 * A refund the gateway refused is retried by the sweep up to MAX_FAILED times,
 * then left for an admin (Top-ups & Refunds lists it).
 *
 * Only escrow payments are refunded here. Before 2026-11-05 a home payment was
 * an ordinary top-up: a cancellation released it to the customer's wallet as
 * spendable money ("money returned to your wallet"), and much of it has been
 * spent since. Those visits were settled under the old rules and are left
 * alone; sending them to the gateway now would take wallet money the customer
 * already used (the wallet refuses: "Insufficient available balance").
 */

const MAX_FAILED = 3;
/** The sweep leaves fresh payments to the confirm that runs right after them. */
const SETTLE_GRACE_MS = 10 * 60 * 1000;

/** Advance states in which the visit kept (part of) the payment. */
const WAS_HELD: AdvanceStatus[] = [
  AdvanceStatus.HELD,
  AdvanceStatus.APPLIED,
  AdvanceStatus.RELEASED,
  AdvanceStatus.PARTIALLY_FORFEITED,
  AdvanceStatus.FORFEITED,
];

/**
 * Escrow payments, by intent id. New ones carry `metadata.escrow`; the
 * description covers those taken between the switch and that flag.
 */
const escrowIntentIds = async (intentIds: string[]) => {
  const rows = await prisma.walletTransaction.findMany({
    where: {
      referenceType: "TOPUP",
      referenceId: { in: intentIds },
      OR: [{ metadata: { path: ["escrow"], equals: true } }, { description: { startsWith: ESCROW_DESCRIPTION } }],
    },
    select: { referenceId: true },
  });
  return new Set(rows.map((r) => r.referenceId));
};

type BookingMoney = {
  id: string;
  status: HomeBookingStatus;
  advanceMinor: number;
  advanceStatus: AdvanceStatus | null;
  refundedMinor: number | null;
  paymentIntentId: string | null;
};

const failedAttempts = (intent: PaymentIntent) => {
  const raw = intent.rawResponse as { refunds?: Array<{ status?: string }> } | null;
  return Array.isArray(raw?.refunds) ? raw.refunds.filter((r) => r?.status === "FAILED").length : 0;
};

/**
 * Per payment, what should have gone back to it in total. The visit keeps
 * `advance − refunded` once the advance was held; that is charged to the
 * booking's own payment first, so any other payment for it goes back whole.
 * Nothing is due while the booking still waits for its payment.
 */
export const gatewayRefundsDue = (b: BookingMoney, intents: Array<Pick<PaymentIntent, "id" | "amountMinor">>) => {
  if (b.status === HomeBookingStatus.PENDING_PAYMENT) return new Map<string, number>();
  const held = b.advanceStatus !== null && WAS_HELD.includes(b.advanceStatus);
  let kept = held ? Math.max(0, b.advanceMinor - (b.refundedMinor ?? 0)) : 0;
  const ordered = [...intents].sort((x, y) => (x.id === b.paymentIntentId ? -1 : y.id === b.paymentIntentId ? 1 : 0));
  const due = new Map<string, number>();
  for (const i of ordered) {
    const keep = Math.min(kept, i.amountMinor);
    kept -= keep;
    due.set(i.id, i.amountMinor - keep);
  }
  return due;
};

export type HomeRefundSummary = { refundedMinor: number; results: IntentRefundResult[] };

/** Sends back to bKash / the card whatever of this visit's payments is not kept. Never throws. */
export const syncHomeRefund = async (bookingId: string, reason: string, opts: { sweep?: boolean } = {}): Promise<HomeRefundSummary> => {
  const summary: HomeRefundSummary = { refundedMinor: 0, results: [] };
  try {
    const b = await prisma.homeBooking.findUnique({
      where: { id: bookingId },
      select: { id: true, code: true, status: true, advanceMinor: true, advanceStatus: true, refundedMinor: true, paymentIntentId: true },
    });
    if (!b) return summary;
    const paid = await prisma.paymentIntent.findMany({
      where: { purpose: IntentPurpose.HOME_BOOKING, referenceId: b.id, status: IntentStatus.SUCCESS },
      orderBy: { createdAt: "asc" },
    });
    if (!paid.length) return summary;
    const escrow = await escrowIntentIds(paid.map((i) => i.id));
    const intents = paid.filter((i) => escrow.has(i.id));
    if (!intents.length) return summary;

    const due = gatewayRefundsDue(b, intents);
    for (const intent of intents) {
      const target = due.get(intent.id) ?? 0;
      if (target <= 0) continue;
      if (opts.sweep && failedAttempts(intent) >= MAX_FAILED) continue;
      const r = await PaymentIntentService.refundIntent(intent, {
        amount: ({ refundedMinor }) => target - refundedMinor,
        reason: `Home visit ${b.code}: ${reason}`,
        by: null,
        auditCtx: systemAuditCtx("job"),
      }).catch((error) => {
        console.error(`[home.refund] ${b.code} intent=${intent.transactionId} refund not sent`, error);
        return null;
      });
      if (!r) continue;
      summary.results.push(r);
      summary.refundedMinor += r.refundedMinor;
      if (r.status !== "COMPLETED") {
        console.error(`[home.refund] ${b.code} intent=${intent.transactionId} ${r.status}: ${r.message}`);
      }
    }
  } catch (error) {
    console.error(`[home.refund] ${bookingId} refund check failed`, error);
  }
  return summary;
};

/**
 * `home.refunds`: every visit with a completed online payment whose money may
 * not all be accounted for: ended, expired or completed, paid more than
 * SETTLE_GRACE_MS ago, in the last 30 days. Cheap: most need nothing and
 * `refundIntent` returns at once.
 */
export const sweepHomeRefunds = async () => {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const settledBefore = new Date(Date.now() - SETTLE_GRACE_MS);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT b.id
    FROM home_bookings b
    JOIN payment_intents i ON i."referenceId" = b.id AND i.purpose = 'HOME_BOOKING' AND i.status = 'SUCCESS'
    WHERE b.status <> 'PENDING_PAYMENT'
      AND EXISTS (
        SELECT 1 FROM wallet_transactions w
        WHERE w."referenceType" = 'TOPUP' AND w."referenceId" = i.id
          AND (w.metadata->>'escrow' = 'true' OR w.description LIKE ${ESCROW_DESCRIPTION + "%"})
      )
      AND i."completedAt" < ${settledBefore}
      AND i."completedAt" > ${since}
      AND (
        b.status IN ('EXPIRED', 'CANCELLED', 'NO_SHOW')
        OR COALESCE(b."refundedMinor", 0) > 0
        OR i."amountMinor" > b."advanceMinor"
        OR (SELECT count(*) FROM payment_intents j WHERE j."referenceId" = b.id AND j.purpose = 'HOME_BOOKING' AND j.status = 'SUCCESS') > 1
      )
    LIMIT 200`;
  let refundedMinor = 0;
  for (const r of rows) refundedMinor += (await syncHomeRefund(r.id, "refund", { sweep: true })).refundedMinor;
  return { checked: rows.length, refundedMinor };
};
