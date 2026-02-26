import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { SalonStatus, UserRole } from "@prisma/client";

const bookAppointment = async (userId: string, payload: any) => {
  // Verify user is customer
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user || user.role !== UserRole.CUSTOMER) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "Only customers can book appointments",
    );
  }

  // Verify salon, service, and staff exist
  const [salon, service, staff, counter] = await Promise.all([
    prisma.salon.findUnique({
      where: {
        id: payload.salonId,
        isDeleted: false,
        status: SalonStatus.ACTIVE,
      },
    }),
    prisma.service.findUnique({
      where: { id: payload.serviceId, isDeleted: false, isActive: true },
    }),
    prisma.staff.findUnique({
      where: { id: payload.staffId, isDeleted: false },
    }),
    prisma.counter.findUnique({
      where: { id: payload.counterId, isDeleted: false },
    }),
  ]);

  if (!salon) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Salon not found or inactive");
  }

  if (!service) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Service not found or inactive");
  }

  if (!staff) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Staff not found");
  }
  if (!counter) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Counter not found");
  }

  // Optional but recommended:
  // make sure staff belongs to this salon
  if (staff.salonId !== payload.salonId) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "Selected staff does not belong to this salon",
    );
  }

  // Prevent duplicate booking on same counter/date/time
  const existingCounterBooking = await prisma.appointment.findFirst({
    where: {
      salonId: payload.salonId,
      counterId: payload.counterId,
      appointmentDate: new Date(payload.appointmentDate),
      startTime: payload.startTime,
      status: {
        in: ["PENDING", "CONFIRMED"], // block active bookings
      },
    },
  });

  if (existingCounterBooking) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      "This counter is already booked for the selected date and time",
    );
  }

  // (Optional) also prevent same staff double booking
  const existingStaffBooking = await prisma.appointment.findFirst({
    where: {
      staffId: payload.staffId,
      appointmentDate: new Date(payload.appointmentDate),
      startTime: payload.startTime,
      status: {
        in: ["PENDING", "CONFIRMED"],
      },
    },
  });

  if (existingStaffBooking) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      "This staff member is already booked for the selected date and time",
    );
  }
  // Create appointment
  const appointment = await prisma.appointment.create({
    data: {
      customerId: userId,
      salonId: payload.salonId,
      serviceId: payload.serviceId,
      staffId: payload.staffId,
      counterId: payload.counterId,
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
      counter: true,
    },
  });

  return appointment;
};

const getAllAppointments = async (
  userId: string,
  userRole: string,
  query: any,
) => {
  const { page = 1, limit = 10, status, salonId } = query;
  const pageNum = Number(page);
  const limitNum = Number(limit);
  const skip = (pageNum - 1) * limitNum;

  const whereConditions: any = {};

  // -------------------------
  // Role-based filtering
  // -------------------------
  if (userRole === UserRole.CUSTOMER) {
    // Customer sees only own appointments
    whereConditions.customerId = userId;
  } else if (userRole === UserRole.STAFF) {
    // Staff userId -> find staff profile -> filter by staffId
    const staff = await prisma.staff.findUnique({
      where: { userId },
      select: { id: true },
    });

    // If staff profile doesn't exist, return no data
    if (!staff) {
      return {
        meta: {
          page: pageNum,
          limit: limitNum,
          total: 0,
        },
        data: [],
      };
    }

    whereConditions.staffId = staff.id;
  } else if (userRole === UserRole.SALON_OWNER) {
    // ✅ userId is from User table, so match by salonOwner.userId
    const salonOwner = await prisma.salonOwner.findUnique({
      where: { userId },
      include: {
        salons: {
          select: { id: true },
        },
      },
    });

    // If no owner profile or no salons, return empty
    if (!salonOwner || salonOwner.salons.length === 0) {
      return {
        meta: {
          page: pageNum,
          limit: limitNum,
          total: 0,
        },
        data: [],
      };
    }

    whereConditions.salonId = {
      in: salonOwner.salons.map((s: any) => s.id),
    };
  }

  // Admin can see all (no extra role filter)
  // else if (userRole === UserRole.ADMIN) { }

  // -------------------------
  // Additional query filters
  // -------------------------
  if (status) {
    whereConditions.status = status;
  }

  // Optional salonId filter
  // For salon owner: this still works, but only if salonId belongs to owner's salons due to previous `in` filter.
  // To avoid override bug, combine carefully:
  if (salonId) {
    // if salonId already has "in" filter from owner, combine with exact match
    if (
      whereConditions.salonId &&
      typeof whereConditions.salonId === "object"
    ) {
      const allowedSalonIds = whereConditions.salonId.in || [];
      if (!allowedSalonIds.includes(salonId)) {
        return {
          meta: {
            page: pageNum,
            limit: limitNum,
            total: 0,
          },
          data: [],
        };
      }
      whereConditions.salonId = salonId;
    } else {
      whereConditions.salonId = salonId;
    }
  }

  const [appointments, total] = await Promise.all([
    prisma.appointment.findMany({
      where: whereConditions,
      skip,
      take: limitNum,
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
        counter: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        payment: true,
      },
      orderBy: [{ appointmentDate: "desc" }, { startTime: "asc" }],
    }),
    prisma.appointment.count({ where: whereConditions }),
  ]);

  return {
    meta: {
      page: pageNum,
      limit: limitNum,
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
      orderBy: { appointmentDate: "desc" },
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
    throw new ApiError(StatusCodes.NOT_FOUND, "Appointment not found");
  }

  return appointment;
};

const updateAppointmentStatus = async (
  userId: string,
  userRole: string,
  appointmentId: string,
  payload: any,
) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      salon: true,
      staff: true,
    },
  });

  if (!appointment) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Appointment not found");
  }

  // Verify permissions
  if (userRole === "CUSTOMER") {
    if (appointment.customerId !== userId) {
      throw new ApiError(
        StatusCodes.FORBIDDEN,
        "You can only update your own appointments",
      );
    }
    // Customers can only cancel
    if (payload.status !== "CANCELLED") {
      throw new ApiError(
        StatusCodes.FORBIDDEN,
        "Customers can only cancel appointments",
      );
    }
  } else if (userRole === "STAFF") {
    if (appointment.staff.userId !== userId) {
      throw new ApiError(
        StatusCodes.FORBIDDEN,
        "You can only update appointments assigned to you",
      );
    }
  } else if (userRole === "SALON_OWNER") {
    const salonOwner = await prisma.salonOwner.findUnique({
      where: { id: userId },
    });
    if (!salonOwner || appointment.salon.ownerId !== salonOwner.id) {
      throw new ApiError(
        StatusCodes.FORBIDDEN,
        "You can only update appointments for your salons",
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
    throw new ApiError(StatusCodes.NOT_FOUND, "Appointment not found");
  }

  if (appointment.customerId !== userId) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "You can only cancel your own appointments",
    );
  }

  if (["COMPLETED", "CANCELLED"].includes(appointment.status)) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `Cannot cancel ${appointment.status.toLowerCase()} appointment`,
    );
  }

  const result = await prisma.appointment.update({
    where: { id: appointmentId },
    data: { status: "CANCELLED" },
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
