import { StatusCodes } from 'http-status-codes';
import ApiError from '../../Error/error';
import prisma from '../../shared/prisma';

const bookAppointment = async (userId: string, payload: any) => {
  // Verify user is customer
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user || user.role !== 'CUSTOMER') {
    throw new ApiError(StatusCodes.FORBIDDEN, 'Only customers can book appointments');
  }

  // Verify salon, service, and staff exist
  const [salon, service, staff] = await Promise.all([
    prisma.salon.findUnique({
      where: { id: payload.salonId, isDeleted: false, status: 'ACTIVE' },
    }),
    prisma.service.findUnique({
      where: { id: payload.serviceId, isDeleted: false, isActive: true },
    }),
    prisma.staff.findUnique({
      where: { id: payload.staffId, isDeleted: false },
    }),
  ]);

  if (!salon) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Salon not found or inactive');
  }

  if (!service) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Service not found or inactive');
  }

  if (!staff) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Staff not found');
  }

  // Create appointment
  const appointment = await prisma.appointment.create({
    data: {
      customerId: userId,
      salonId: payload.salonId,
      serviceId: payload.serviceId,
      staffId: payload.staffId,
      appointmentDate: new Date(payload.appointmentDate),
      startTime: payload.startTime,
      notes: payload.notes,
    },
    include: {
      salon: {
        select: {
          id: true,
          name: true,
          address: true,
          phone: true,
        },
      },
      service: {
        select: {
          id: true,
          name: true,
          price: true,
          duration: true,
        },
      },
      staff: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              profilePhoto: true,
            },
          },
        },
      },
    },
  });

  return appointment;
};

const getAllAppointments = async (userId: string, userRole: string, query: any) => {
  const { page = 1, limit = 10, status, salonId } = query;
  const skip = (Number(page) - 1) * Number(limit);

  const whereConditions: any = {};

  // Filter based on role
  if (userRole === 'CUSTOMER') {
    whereConditions.customerId = userId;
  } else if (userRole === 'STAFF') {
    const staff = await prisma.staff.findUnique({
      where: { userId },
    });
    if (staff) {
      whereConditions.staffId = staff.id;
    }
  } else if (userRole === 'SALON_OWNER') {
    const salonOwner = await prisma.salonOwner.findUnique({
      where: { userId },
      include: { salons: { select: { id: true } } },
    });
    if (salonOwner) {
      whereConditions.salonId = {
        in: salonOwner.salons.map((s) => s.id),
      };
    }
  }

  if (status) {
    whereConditions.status = status;
  }

  if (salonId) {
    whereConditions.salonId = salonId;
  }

  const [appointments, total] = await Promise.all([
    prisma.appointment.findMany({
      where: whereConditions,
      skip,
      take: Number(limit),
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            profilePhoto: true,
          },
        },
        salon: {
          select: {
            id: true,
            name: true,
            address: true,
            phone: true,
          },
        },
        service: {
          select: {
            id: true,
            name: true,
            price: true,
            duration: true,
            category: true,
          },
        },
        staff: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                profilePhoto: true,
              },
            },
          },
        },
        payment: true,
      },
      orderBy: { appointmentDate: 'desc' },
    }),
    prisma.appointment.count({ where: whereConditions }),
  ]);

  return {
    meta: {
      page: Number(page),
      limit: Number(limit),
      total,
    },
    data: appointments,
  };
};

const getMyAppointments = async (userId: string, query: any) => {
  const { page = 1, limit = 10, status } = query;
  const skip = (Number(page) - 1) * Number(limit);

  const whereConditions: any = {
    customerId: userId,
  };

  if (status) {
    whereConditions.status = status;
  }

  const [appointments, total] = await Promise.all([
    prisma.appointment.findMany({
      where: whereConditions,
      skip,
      take: Number(limit),
      include: {
        salon: {
          select: {
            id: true,
            name: true,
            address: true,
            phone: true,
          },
        },
        service: {
          select: {
            id: true,
            name: true,
            price: true,
            duration: true,
            category: true,
          },
        },
        staff: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                profilePhoto: true,
              },
            },
          },
        },
        payment: true,
      },
      orderBy: { appointmentDate: 'desc' },
    }),
    prisma.appointment.count({ where: whereConditions }),
  ]);

  return {
    meta: {
      page: Number(page),
      limit: Number(limit),
      total,
    },
    data: appointments,
  };
};

const getAppointmentById = async (id: string) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id },
    include: {
      customer: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          profilePhoto: true,
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
              profilePhoto: true,
              phone: true,
            },
          },
        },
      },
      payment: true,
      review: true,
    },
  });

  if (!appointment) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Appointment not found');
  }

  return appointment;
};

const updateAppointmentStatus = async (
  userId: string,
  userRole: string,
  appointmentId: string,
  payload: any
) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      salon: true,
      staff: true,
    },
  });

  if (!appointment) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Appointment not found');
  }

  // Verify permissions
  if (userRole === 'CUSTOMER') {
    if (appointment.customerId !== userId) {
      throw new ApiError(StatusCodes.FORBIDDEN, 'You can only update your own appointments');
    }
    // Customers can only cancel
    if (payload.status !== 'CANCELLED') {
      throw new ApiError(StatusCodes.FORBIDDEN, 'Customers can only cancel appointments');
    }
  } else if (userRole === 'STAFF') {
    if (appointment.staff.userId !== userId) {
      throw new ApiError(
        StatusCodes.FORBIDDEN,
        'You can only update appointments assigned to you'
      );
    }
  } else if (userRole === 'SALON_OWNER') {
    const salonOwner = await prisma.salonOwner.findUnique({
      where: { userId },
    });
    if (!salonOwner || appointment.salon.ownerId !== salonOwner.id) {
      throw new ApiError(
        StatusCodes.FORBIDDEN,
        'You can only update appointments for your salons'
      );
    }
  }

  const result = await prisma.appointment.update({
    where: { id: appointmentId },
    data: {
      status: payload.status,
      cancellationReason: payload.cancellationReason,
    },
  });

  return result;
};

const cancelAppointment = async (userId: string, appointmentId: string) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
  });

  if (!appointment) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Appointment not found');
  }

  if (appointment.customerId !== userId) {
    throw new ApiError(StatusCodes.FORBIDDEN, 'You can only cancel your own appointments');
  }

  if (['COMPLETED', 'CANCELLED'].includes(appointment.status)) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `Cannot cancel ${appointment.status.toLowerCase()} appointment`
    );
  }

  const result = await prisma.appointment.update({
    where: { id: appointmentId },
    data: { status: 'CANCELLED' },
  });

  return result;
};

export const AppointmentService = {
  bookAppointment,
  getAllAppointments,
  getMyAppointments,
  getAppointmentById,
  updateAppointmentStatus,
  cancelAppointment,
};
