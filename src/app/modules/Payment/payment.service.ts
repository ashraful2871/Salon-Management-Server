import { PaymentMethod, PaymentStatus, Prisma, UserRole } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import {
  assertCanActOnAppointment,
  ownedSalonIds,
} from "../../utils/salonAccess";
import { paymentSummary } from "../Appointment/appointment.billing";

/**
 * This module records money collected *at the counter*. It is deliberately not
 * a way for anyone to declare a payment: the amount is always derived from the
 * appointment, never taken from the request body, and only the salon that owns
 * the appointment (or an admin) may record one. Online money enters through
 * the wallet top-up flow and its IPN, which is the only path that credits.
 */

/** Cash-equivalent methods a salon can settle at the counter. */
const COUNTER_METHODS: PaymentMethod[] = [
  PaymentMethod.CASH,
  PaymentMethod.CARD,
  PaymentMethod.MOBILE_BANKING,
];

const serviceSelect = {
  id: true,
  name: true,
  priceMinor: true,
} as const;

const PAYMENT_ACCESS_MESSAGE =
  "You can only record payments for your own salons";

const createPayment = async (
  userId: string,
  userRole: string,
  payload: { appointmentId: string; paymentMethod: PaymentMethod },
) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: payload.appointmentId },
    include: { service: { select: serviceSelect } },
  });

  if (!appointment) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Appointment not found");
  }

  await assertCanActOnAppointment(
    userId,
    userRole,
    appointment.salonId,
    PAYMENT_ACCESS_MESSAGE,
  );

  if (!COUNTER_METHODS.includes(payload.paymentMethod)) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "Online payments are taken through the wallet top-up flow, not recorded here",
    );
  }

  if (appointment.status === "CANCELLED" || appointment.status === "NO_SHOW") {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `Cannot record a payment against a ${appointment.status === "CANCELLED" ? "cancelled" : "no-show"} appointment`,
    );
  }

  const existingPayment = await prisma.payment.findUnique({
    where: { appointmentId: payload.appointmentId },
  });

  if (existingPayment) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      "Payment already exists for this appointment",
    );
  }

  // The amount is the server's to decide. `totalMinor` was captured when the
  // booking was made, so a later price change cannot alter an agreed bill; a
  // deposit the customer has paid - still held or already applied - comes off
  // what is still owed.
  const { amountDueMinor: amountMinor } = paymentSummary({
    ...appointment,
    totalMinor: appointment.totalMinor || appointment.service.priceMinor,
    payment: null,
  });

  return prisma.payment.create({
    data: {
      appointmentId: payload.appointmentId,
      amountMinor,
      paymentMethod: payload.paymentMethod,
      // Recording a counter payment *is* the act of collecting it.
      status: PaymentStatus.COMPLETED,
      paymentDate: new Date(),
    },
    include: {
      appointment: {
        include: {
          customer: { select: { id: true, name: true, email: true } },
          service: { select: serviceSelect },
        },
      },
    },
  });
};

const getAllPayments = async (userId: string, userRole: string, query: any) => {
  const { page = 1, limit = 10, status } = query;
  const pageNum = Number(page);
  const limitNum = Number(limit);
  const skip = (pageNum - 1) * limitNum;

  const whereConditions: Prisma.PaymentWhereInput = {};

  if (userRole === UserRole.SALON_OWNER) {
    const salonIds = await ownedSalonIds(userId);

    if (salonIds.length === 0) {
      return { meta: { page: pageNum, limit: limitNum, total: 0 }, data: [] };
    }

    whereConditions.appointment = { salonId: { in: salonIds } };
  }

  if (status) {
    whereConditions.status = status as PaymentStatus;
  }

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where: whereConditions,
      skip,
      take: limitNum,
      include: {
        appointment: {
          include: {
            customer: { select: { id: true, name: true, email: true } },
            salon: { select: { id: true, name: true } },
            service: { select: serviceSelect },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.payment.count({ where: whereConditions }),
  ]);

  return {
    meta: { page: pageNum, limit: limitNum, total },
    data: payments,
  };
};

const getPaymentById = async (id: string, userId: string, userRole: string) => {
  const payment = await prisma.payment.findUnique({
    where: { id },
    include: {
      appointment: {
        include: {
          customer: {
            select: { id: true, name: true, email: true, phone: true },
          },
          salon: true,
          service: true,
          staff: {
            include: { user: { select: { id: true, name: true } } },
          },
        },
      },
    },
  });

  if (!payment) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Payment not found");
  }

  // A payment id is guessable enough that "found" must not mean "readable".
  if (userRole === UserRole.CUSTOMER) {
    if (payment.appointment.customerId !== userId) {
      throw new ApiError(StatusCodes.NOT_FOUND, "Payment not found");
    }
  } else if (userRole === UserRole.SALON_OWNER) {
    const salonIds = await ownedSalonIds(userId);
    if (!salonIds.includes(payment.appointment.salonId)) {
      throw new ApiError(StatusCodes.NOT_FOUND, "Payment not found");
    }
  }

  return payment;
};

const updatePaymentStatus = async (
  id: string,
  userId: string,
  userRole: string,
  payload: { status: PaymentStatus },
) => {
  const payment = await prisma.payment.findUnique({
    where: { id },
    include: { appointment: { select: { salonId: true } } },
  });

  if (!payment) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Payment not found");
  }

  await assertCanActOnAppointment(
    userId,
    userRole,
    payment.appointment.salonId,
    PAYMENT_ACCESS_MESSAGE,
  );

  return prisma.payment.update({
    where: { id },
    data: { status: payload.status },
    include: {
      appointment: {
        include: {
          customer: { select: { id: true, name: true, email: true } },
          service: { select: serviceSelect },
        },
      },
    },
  });
};

export const PaymentService = {
  createPayment,
  getAllPayments,
  getPaymentById,
  updatePaymentStatus,
};
