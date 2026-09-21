import {
  AppointmentStatus,
  DepositStatus,
  PaymentStatus,
} from "@prisma/client";

/**
 * Where a booking's bill stands. "Confirmed" only means the slot is held; this
 * is the separate answer to "has it been paid", computed here once so the owner
 * and the customer can never be shown different numbers.
 *
 * - UNPAID: something is still owed at the counter.
 * - PAID: nothing is owed, whether the counter took the rest or the deposit
 *   covered it.
 * - UNRECORDED: the booking was completed but nobody recorded what the counter
 *   took. The salon has to fix it; the customer is not to blame.
 * - REFUNDED: the counter payment was given back.
 * - NOT_APPLICABLE: cancelled or no-show, so there is no bill.
 */
export type PaymentState =
  | "UNPAID"
  | "PAID"
  | "UNRECORDED"
  | "REFUNDED"
  | "NOT_APPLICABLE";

export type BillableAppointment = {
  status: AppointmentStatus;
  totalMinor: number;
  depositMinor: number;
  depositStatus: DepositStatus;
  payment?: { amountMinor: number; status: PaymentStatus } | null;
};

export const paymentSummary = (a: BillableAppointment) => {
  // A HELD deposit has left the customer's wallet just as surely as an APPLIED
  // one; it only has not been booked to the salon yet.
  const depositPaidMinor =
    a.depositStatus === DepositStatus.HELD ||
    a.depositStatus === DepositStatus.APPLIED
      ? a.depositMinor
      : 0;

  const paidAtCounterMinor =
    a.payment?.status === PaymentStatus.COMPLETED ? a.payment.amountMinor : 0;

  const refunded = a.payment?.status === PaymentStatus.REFUNDED;

  if (
    a.status === AppointmentStatus.CANCELLED ||
    a.status === AppointmentStatus.NO_SHOW
  ) {
    return {
      depositPaidMinor,
      paidAtCounterMinor,
      amountDueMinor: 0,
      paymentState: (refunded ? "REFUNDED" : "NOT_APPLICABLE") as PaymentState,
    };
  }

  const amountDueMinor = Math.max(
    a.totalMinor - depositPaidMinor - paidAtCounterMinor,
    0,
  );

  const paymentState: PaymentState = refunded
    ? "REFUNDED"
    : paidAtCounterMinor > 0 || amountDueMinor === 0
      ? "PAID"
      : a.status === AppointmentStatus.COMPLETED
        ? "UNRECORDED"
        : "UNPAID";

  return { depositPaidMinor, paidAtCounterMinor, amountDueMinor, paymentState };
};

/** The row as loaded, with its payment summary alongside. */
export const withPaymentSummary = <T extends BillableAppointment>(a: T) => ({
  ...a,
  ...paymentSummary(a),
});

export const AppointmentBilling = { paymentSummary, withPaymentSummary };
