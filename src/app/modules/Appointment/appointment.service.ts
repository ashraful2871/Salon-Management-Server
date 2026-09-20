import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import {
  AppointmentStatus,
  DepositStatus,
  SalonStatus,
  UserRole,
} from "@prisma/client";
import { sendEmail } from "../../utils/emailSender";
import { getBookingConfirmationTemplate } from "../../utils/emailTemplates";
import { formatBDT } from "../../utils/money";
import { hasSlotStarted } from "../../utils/slotTime";
import { WalletService } from "../Wallet/wallet.service";
import { AppointmentDeposit } from "./appointment.deposit";
import { AppointmentIdentity } from "./appointment.identity";

const bookAppointment = async (userId: string, payload: any) => {
  // Verify user is customer
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (
    !user ||
    (user.role !== UserRole.CUSTOMER &&
      user.role !== UserRole.SALON_OWNER &&
      user.role !== UserRole.ADMIN)
  ) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "Only customers can book appointments",
    );
  }

  // Verify slot first
  const slot = await prisma.slot.findUnique({
    where: { id: payload.slotId },
  });

  if (!slot || slot.status !== "AVAILABLE" || slot.isBooked) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      "This slot is no longer available. Please select another time.",
    );
  }

  // The list is filtered, but a stale tab or a hand-edited request can still
  // arrive for a time that has already come and gone. Selling it would create a
  // booking that the auto-start job immediately marks IN_PROGRESS and the
  // no-show sweep then forfeits - a deposit lost to a slot nobody could attend.
  if (hasSlotStarted(slot)) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      "That time has already passed. Please select a later slot.",
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
    payload.staffId
      ? prisma.staff.findUnique({
          where: { id: payload.staffId, isDeleted: false },
        })
      : Promise.resolve(null),
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

  if (payload.staffId && !staff) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Staff not found");
  }
  if (!counter) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Counter not found");
  }

  if (staff && staff.salonId !== payload.salonId) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "Selected staff does not belong to this salon",
    );
  }

  // What this booking costs, and what it costs to not turn up. Both are frozen
  // onto the appointment now, so a later price or policy change cannot rewrite
  // a deal the customer already agreed to.
  const totalMinor = service.priceMinor;
  const depositMinor = AppointmentDeposit.resolveDepositMinor(
    salon,
    totalMinor,
  );

  // Transaction for double booking prevention. The deposit hold lives in here
  // too: if the customer cannot cover it the whole thing rolls back and the
  // slot is released, rather than leaving a booking nobody has paid to keep.
  const appointment = await prisma
    .$transaction(
      async (tx) => {
        const updatedSlot = await tx.slot.updateMany({
          where: {
            id: payload.slotId,
            status: "AVAILABLE",
            isBooked: false,
          },
          data: {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            status: "BOOKED",
            isBooked: true,
          },
        });

        if (updatedSlot.count === 0) {
          throw new ApiError(
            StatusCodes.CONFLICT,
            "Sorry, this slot has just been booked by another customer. Please select another available slot.",
          );
        }

        // Queue identity. The serial is allocated under an advisory lock keyed on
        // salon + service + day, so two customers booking the same morning at
        // the same moment cannot both be told they are #4.
        // Sequential, not Promise.all: these share one transaction connection,
        // and the serial allocation takes a lock the other query must not race.
        const token = await AppointmentIdentity.generateToken(tx);
        const serialNumber = await AppointmentIdentity.nextSerialNumber(tx, {
          salonId: payload.salonId,
          serviceId: payload.serviceId,
          appointmentDate: slot.date,
        });

        const createdAppointment = await tx.appointment.create({
          data: {
            customerId: userId,
            salonId: payload.salonId,
            serviceId: payload.serviceId,
            staffId: payload.staffId || null,
            counterId: payload.counterId,
            appointmentDate: slot.date,
            startTime: slot.startTime,
            endTime: slot.endTime,
            notes: payload.notes,
            slotId: slot.id,
            token,
            serialNumber,
            // The deposit is taken here and now, so there is nothing left for
            // the salon to confirm - a paid booking is a confirmed booking.
            status: AppointmentStatus.CONFIRMED,
            totalMinor,
            depositMinor,
            depositStatus:
              depositMinor > 0 ? DepositStatus.HELD : DepositStatus.NONE,
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
                priceMinor: true,
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

        if (depositMinor > 0) {
          await WalletService.holdDeposit(
            userId,
            depositMinor,
            createdAppointment.id,
            tx,
          );
        }

        return createdAppointment;
      },
      { timeout: 15000, maxWait: 10000 },
    )
    .catch(async (error) => {
      // An empty wallet is not a server error - it is a prompt to top up.
      if (
        error instanceof ApiError &&
        error.statusCode === StatusCodes.BAD_REQUEST &&
        error.message.startsWith("Insufficient")
      ) {
        const wallet = await WalletService.getWalletSummary(userId);
        const shortfall = Math.max(depositMinor - wallet.availableMinor, 0);

        throw new ApiError(
          StatusCodes.PAYMENT_REQUIRED,
          `Add ${formatBDT(shortfall)} to your wallet to confirm this booking. A ${formatBDT(depositMinor)} deposit is held and returned when you turn up.`,
        );
      }

      throw error;
    });

  // Send email notification asynchronously
  if (user?.email) {
    const formattedDate = new Date(
      appointment.appointmentDate,
    ).toLocaleDateString();
    const emailHtml = getBookingConfirmationTemplate(
      user.name || "Customer",
      appointment.salon.name,
      appointment.service.name,
      formattedDate,
      appointment.startTime,
      depositMinor > 0
        ? `${formatBDT(totalMinor)} (${formatBDT(depositMinor)} deposit held, ${formatBDT(totalMinor - depositMinor)} due at the salon)`
        : formatBDT(totalMinor),
      {
        token: appointment.token,
        serialNumber: appointment.serialNumber,
        staffName: appointment.staff?.user?.name,
        counterName: appointment.counter?.name,
      },
    );

    // Call without await so it doesn't block the API response
    sendEmail(user.email, "Booking Confirmation - Salon Management", emailHtml);
  }

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
  else if (userRole === "AGENT") {
    const agent = await prisma.agent.findUnique({
      where: { userId },
      select: { area: true },
    });

    if (!agent) {
      return { meta: { page: pageNum, limit: limitNum, total: 0 }, data: [] };
    }

    // Find all salons in this agent's area
    const salonsInArea = await prisma.salon.findMany({
      where: { area: agent.area, isDeleted: false },
      select: { id: true },
    });

    whereConditions.salonId = {
      in: salonsInArea.map((s: any) => s.id),
    };
  }

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
            priceMinor: true,
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
      orderBy: { createdAt: "desc" },
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
  const { page = 1, limit = 10, status, salonId } = query;
  const skip = (Number(page) - 1) * Number(limit);

  const whereConditions: any = {
    customerId: userId,
  };

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
            priceMinor: true,
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
        review: true,
      },
      orderBy: { createdAt: "desc" },
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
      counter: true,
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
  if (userRole === UserRole.CUSTOMER) {
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
  } else if (userRole === UserRole.STAFF) {
    if (appointment?.staff?.userId !== userId) {
      throw new ApiError(
        StatusCodes.FORBIDDEN,
        "You can only update appointments assigned to you",
      );
    }
  } else if (userRole === UserRole.SALON_OWNER) {
    const salonOwner = await prisma.salonOwner.findUnique({
      where: { userId },
    });
    if (!salonOwner || appointment.salon.ownerId !== salonOwner.id) {
      throw new ApiError(
        StatusCodes.FORBIDDEN,
        "You can only update appointments for your salons",
      );
    }
  }

  if (
    payload.staffId &&
    userRole !== UserRole.SALON_OWNER &&
    userRole !== UserRole.ADMIN
  ) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "Only salon owners can assign staff to appointments",
    );
  }

  // A no-show forfeits real money, so it is the one transition with its own
  // guard: only the salon or an admin, and only once the slot has passed.
  if (payload.status === "NO_SHOW") {
    AppointmentDeposit.assertCanMarkNoShow(userRole, appointment);
  }

  // A customer cancelling through this endpoint gets the same time check as the
  // dedicated cancel route - otherwise it is a way around it.
  if (payload.status === "CANCELLED" && userRole === UserRole.CUSTOMER) {
    AppointmentDeposit.assertCancellable(appointment);
  }

  const result = await prisma.appointment.update({
    where: { id: appointmentId },
    data: {
      status: payload.status,
      cancellationReason: payload.cancellationReason,
      ...(payload.staffId && { staffId: payload.staffId }),
    },
  });

  if (payload.status === "CANCELLED" && appointment.slotId) {
    await prisma.slot.update({
      where: { id: appointment.slotId },
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      data: { status: "AVAILABLE", isBooked: false },
    });
  }

  // Resolve the deposit against the outcome. Each branch is idempotent by
  // appointment id, so a retried request cannot charge or refund twice.
  if (payload.status === "COMPLETED") {
    await AppointmentDeposit.settleCompleted(appointmentId);
  } else if (payload.status === "NO_SHOW") {
    await AppointmentDeposit.settleForfeited(appointmentId);
  } else if (payload.status === "CANCELLED") {
    if (userRole === UserRole.CUSTOMER) {
      // Cancelling too late costs the salon a slot it cannot refill, so it
      // costs the customer a slice of the deposit - but only a slice.
      const inTime = AppointmentDeposit.isWithinFreeCancellation(
        appointment,
        appointment.salon,
      );
      await (inTime
        ? AppointmentDeposit.settleReleased(appointmentId)
        : AppointmentDeposit.settleLateCancelled(appointmentId));
    } else {
      // The salon or an admin cancelled: the customer is made whole and gets a
      // salon-funded credit for the trouble.
      await AppointmentDeposit.settleReleased(appointmentId, {
        goodwill: true,
      });
    }
  }

  return result;
};

const cancelAppointment = async (userId: string, appointmentId: string) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { salon: true },
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

  if (
    ["COMPLETED", "CANCELLED", "IN_PROGRESS", "NO_SHOW"].includes(
      appointment.status,
    )
  ) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `Cannot cancel ${appointment.status.toLowerCase().replace("_", " ")} appointment`,
    );
  }

  // Past the start time there is nothing to cancel - only a completion or a
  // no-show. This has to come before any write.
  AppointmentDeposit.assertCancellable(appointment);

  const quote = AppointmentDeposit.cancellationQuote(
    appointment,
    appointment.salon,
  );

  const result = await prisma.appointment.update({
    where: { id: appointmentId },
    data: { status: "CANCELLED" },
  });

  if (appointment.slotId) {
    await prisma.slot.update({
      where: { id: appointment.slotId },
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      data: { status: "AVAILABLE", isBooked: false },
    });
  }

  // Outside the window the deposit comes back whole. Inside it the slot is too
  // close to resell, so the salon keeps the penalty and the customer gets the
  // rest back - a late cancellation is not as expensive as never showing up.
  await (quote.freeCancellation
    ? AppointmentDeposit.settleReleased(appointmentId)
    : AppointmentDeposit.settleLateCancelled(appointmentId));

  return {
    ...result,
    depositRefunded: quote.refundMinor > 0,
    fullRefund: quote.freeCancellation,
    depositMinor: quote.depositMinor,
    refundMinor: quote.refundMinor,
    penaltyMinor: quote.penaltyMinor,
    penaltyPercent: quote.penaltyPercent,
    cancellationWindowMin: appointment.salon.cancellationWindowMin,
  };
};

/**
 * What cancelling right now would cost. The frontend shows this before the
 * confirm button, so a forfeit is never a surprise.
 */
const getCancellationPreview = async (
  userId: string,
  appointmentId: string,
) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { salon: true },
  });

  if (!appointment || appointment.customerId !== userId) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Appointment not found");
  }

  const quote = AppointmentDeposit.cancellationQuote(
    appointment,
    appointment.salon,
  );

  return {
    appointmentId,
    startsAt: quote.startsAt,
    cancellationWindowMin: quote.cancellationWindowMin,
    depositMinor: quote.depositMinor,
    freeCancellation: quote.freeCancellation,
    refundMinor: quote.refundMinor,
    // Kept under the old name so existing clients still read the deduction.
    forfeitMinor: quote.penaltyMinor,
    penaltyMinor: quote.penaltyMinor,
    penaltyPercent: quote.penaltyPercent,
    // False once the appointment has started: cancelling is no longer allowed.
    cancellable: !quote.started,
  };
};

const appealNoShow = async (
  userId: string,
  appointmentId: string,
  reason: string,
) => AppointmentDeposit.appealNoShow(userId, appointmentId, reason);

const resolveAppeal = async (
  adminUserId: string,
  appointmentId: string,
  payload: { approve: boolean; note?: string },
) => AppointmentDeposit.resolveAppeal(adminUserId, appointmentId, payload);

export const AppointmentService = {
  bookAppointment,
  getAllAppointments,
  getMyAppointments,
  getAppointmentById,
  updateAppointmentStatus,
  cancelAppointment,
  getCancellationPreview,
  appealNoShow,
  resolveAppeal,
};
