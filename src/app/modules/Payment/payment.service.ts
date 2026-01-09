import { StatusCodes } from 'http-status-codes';
import ApiError from '../../Error/error';
import prisma from '../../shared/prisma';

const createPayment = async (payload: any) => {
  // Verify appointment exists
  const appointment = await prisma.appointment.findUnique({
    where: { id: payload.appointmentId },
    include: { service: true },
  });

  if (!appointment) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Appointment not found');
  }

  // Check if payment already exists
  const existingPayment = await prisma.payment.findUnique({
    where: { appointmentId: payload.appointmentId },
  });

  if (existingPayment) {
    throw new ApiError(StatusCodes.CONFLICT, 'Payment already exists for this appointment');
  }

  const payment = await prisma.payment.create({
    data: {
      appointmentId: payload.appointmentId,
      amount: payload.amount || appointment.service.price,
      paymentMethod: payload.paymentMethod,
      status: payload.status || 'PENDING',
      transactionId: payload.transactionId,
      paymentDate: payload.paymentDate ? new Date(payload.paymentDate) : undefined,
    },
    include: {
      appointment: {
        include: {
          customer: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          service: {
            select: {
              id: true,
              name: true,
              price: true,
            },
          },
        },
      },
    },
  });

  return payment;
};

const getAllPayments = async (userId: string, userRole: string, query: any) => {
  const { page = 1, limit = 10, status } = query;
  const skip = (Number(page) - 1) * Number(limit);

  const whereConditions: any = {};

  // Filter based on role
  if (userRole === 'SALON_OWNER') {
    const salonOwner = await prisma.salonOwner.findUnique({
      where: { userId },
      include: { salons: { select: { id: true } } },
    });
    if (salonOwner) {
      whereConditions.appointment = {
        salonId: {
          in: salonOwner.salons.map((s: any) => s.id),
        },
      };
    }
  }

  if (status) {
    whereConditions.status = status;
  }

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where: whereConditions,
      skip,
      take: Number(limit),
      include: {
        appointment: {
          include: {
            customer: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            salon: {
              select: {
                id: true,
                name: true,
              },
            },
            service: {
              select: {
                id: true,
                name: true,
                price: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.payment.count({ where: whereConditions }),
  ]);

  return {
    meta: {
      page: Number(page),
      limit: Number(limit),
      total,
    },
    data: payments,
  };
};

const getPaymentById = async (id: string) => {
  const payment = await prisma.payment.findUnique({
    where: { id },
    include: {
      appointment: {
        include: {
          customer: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
            },
          },
          salon: true,
          service: true,
          staff: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!payment) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Payment not found');
  }

  return payment;
};

export const PaymentService = {
  createPayment,
  getAllPayments,
  getPaymentById,
};
