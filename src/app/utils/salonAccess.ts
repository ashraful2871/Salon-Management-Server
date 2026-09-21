import { UserRole } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../Error/error";
import prisma from "../shared/prisma";

/** The salons behind a SALON_OWNER user; empty if they have no owner profile. */
export const ownedSalonIds = async (userId: string) => {
  const owner = await prisma.salonOwner.findUnique({
    where: { userId },
    include: { salons: { select: { id: true } } },
  });

  return owner ? owner.salons.map((salon) => salon.id) : [];
};

/**
 * Whether this user may act on a booking at `salonId`: an admin anywhere, an
 * owner at their own salons, staff at the salon they work for. Anyone else -
 * including a customer, even on their own booking - is refused.
 */
export const assertCanActOnAppointment = async (
  userId: string,
  userRole: string,
  salonId: string,
  message = "You can only manage bookings for your own salon",
) => {
  if (userRole === UserRole.ADMIN) return;

  if (userRole === UserRole.SALON_OWNER) {
    const salonIds = await ownedSalonIds(userId);
    if (salonIds.includes(salonId)) return;
  }

  if (userRole === UserRole.STAFF) {
    const staff = await prisma.staff.findUnique({ where: { userId } });
    if (staff && !staff.isDeleted && staff.salonId === salonId) return;
  }

  throw new ApiError(StatusCodes.FORBIDDEN, message);
};
