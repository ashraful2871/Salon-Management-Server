import {
  AppointmentStatus,
  DepositStatus,
  WalletTxType,
} from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { assertBookingPermission } from "../../utils/salonAccess";
import { formatBDT } from "../../utils/money";
import { WalletService } from "../Wallet/wallet.service";
import { SettlementService } from "../Settlement/settlement.service";
import { billableMinor } from "./appointment.billing";
import { heldMinor } from "./appointment.deposit";

/**
 * A salon refunding a completed booking (owner Phase 15). The money paid in
 * the app - deposit plus any prepaid bill - goes back to the customer's
 * wallet, never to the gateway; the salon carries it. Commission comes back
 * only when the whole bill was paid in the app and all of it is refunded.
 */

type Actor = { userId: string; role: string };

const REFUND_KEY_PREFIX = "salon-refund:";

export const refundCompleted = async (
  user: Actor,
  appointmentId: string,
  payload: { amountMinor: number; reason: string },
) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { salon: { select: { name: true } } },
  });
  if (!appointment) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Appointment not found");
  }

  await assertBookingPermission(user, appointment, "bookings.manage");

  if (
    appointment.status !== AppointmentStatus.COMPLETED ||
    appointment.depositStatus !== DepositStatus.APPLIED ||
    heldMinor(appointment) <= 0
  ) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      "Only a completed booking paid in the app can be refunded here",
    );
  }

  const appliedMinor = heldMinor(appointment);
  const reason = payload.reason.trim();

  return prisma.$transaction(
    async (tx) => {
      // One refund at a time per booking, so two clicks cannot both read the
      // same "refunded so far" and together exceed what was paid.
      await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${appointmentId} FOR UPDATE`;

      const prior = await tx.walletTransaction.aggregate({
        where: {
          type: WalletTxType.REFUND,
          referenceType: "APPOINTMENT",
          referenceId: appointmentId,
          idempotencyKey: { startsWith: REFUND_KEY_PREFIX },
        },
        _sum: { amount: true },
        _count: { _all: true },
      });
      const refundedMinor = prior._sum.amount ?? 0;
      const leftMinor = appliedMinor - refundedMinor;

      if (payload.amountMinor > leftMinor) {
        throw new ApiError(
          StatusCodes.BAD_REQUEST,
          leftMinor > 0
            ? `At most ${formatBDT(leftMinor)} can still be refunded`
            : "This booking has already been refunded in full",
        );
      }

      const full =
        refundedMinor + payload.amountMinor === appliedMinor &&
        appliedMinor >= billableMinor(appointment);

      await WalletService.mutate(
        {
          userId: appointment.customerId,
          type: WalletTxType.REFUND,
          amount: payload.amountMinor,
          description: `Refund from ${appointment.salon.name}: ${reason}`,
          referenceType: "APPOINTMENT",
          referenceId: appointmentId,
          idempotencyKey: `${REFUND_KEY_PREFIX}${appointmentId}:${prior._count._all + 1}`,
          metadata: { reason, byUserId: user.userId },
        },
        tx,
      );

      const commissionReturnedMinor = await SettlementService.recordSalonRefund(
        tx,
        appointment,
        payload.amountMinor,
        full,
      );

      return {
        appointmentId,
        refundedMinor: payload.amountMinor,
        totalRefundedMinor: refundedMinor + payload.amountMinor,
        refundableMinor: leftMinor - payload.amountMinor,
        commissionReturnedMinor,
        fullRefund: full,
      };
    },
    { timeout: 15000, maxWait: 10000 },
  );
};

/** What is still refundable, for the owner's booking view. */
export const refundableMinor = async (appointmentId: string, appliedMinor: number) => {
  const prior = await prisma.walletTransaction.aggregate({
    where: {
      type: WalletTxType.REFUND,
      referenceType: "APPOINTMENT",
      referenceId: appointmentId,
      idempotencyKey: { startsWith: REFUND_KEY_PREFIX },
    },
    _sum: { amount: true },
  });
  return Math.max(appliedMinor - (prior._sum.amount ?? 0), 0);
};

export const AppointmentRefund = { refundCompleted, refundableMinor };
