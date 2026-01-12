import { StatusCodes } from "http-status-codes";
import { Prisma } from "@prisma/client";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";

const addStaff = async (ownerId: string, payload: any) => {
  // Verify salon ownership
  const salonOwner = await prisma.salonOwner.findUnique({
    where: { userId: ownerId },
  });

  if (!salonOwner) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "Only salon owners can add staff"
    );
  }

  const salon = await prisma.salon.findUnique({
    where: {
      id: payload.salonId,
      isDeleted: false,
    },
  });

  if (!salon) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Salon not found");
  }

  if (salon.ownerId !== salonOwner.id) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "You can only add staff to your own salons"
    );
  }

  // Check if user exists
  const user = await prisma.user.findUnique({
    where: {
      id: payload.userId,
      isDeleted: false,
    },
  });

  if (!user) {
    throw new ApiError(StatusCodes.NOT_FOUND, "User not found");
  }

  // Check if user is already staff somewhere
  const existingStaff = await prisma.staff.findUnique({
    where: { userId: payload.userId },
  });

  if (existingStaff) {
    throw new ApiError(StatusCodes.CONFLICT, "User is already a staff member");
  }

  // Create staff in transaction
  const result = await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      // Update user role to STAFF
      await tx.user.update({
        where: { id: payload.userId },
        data: { role: "STAFF" },
      });

      // Create staff record
      const staff = await tx.staff.create({
        data: {
          userId: payload.userId,
          salonId: payload.salonId,
          speciality: payload.speciality,
          experience: payload.experience,
          bio: payload.bio,
        },
        include: {
          user: {
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
            },
          },
        },
      });

      // Link services if provided
      if (payload.serviceIds && payload.serviceIds.length > 0) {
        await tx.staffService.createMany({
          data: payload.serviceIds.map((serviceId: string) => ({
            staffId: staff.id,
            serviceId,
          })),
        });
      }

      return staff;
    }
  );

  return result;
};

const getAllStaff = async (query: any) => {
  const { page = 1, limit = 10, salonId, status } = query;
  const skip = (Number(page) - 1) * Number(limit);

  const whereConditions: any = {
    isDeleted: false,
  };

  if (salonId) {
    whereConditions.salonId = salonId;
  }

  if (status) {
    whereConditions.status = status;
  }

  const [staff, total] = await Promise.all([
    prisma.staff.findMany({
      where: whereConditions,
      skip,
      take: Number(limit),
      include: {
        user: {
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
            city: true,
          },
        },
        staffServices: {
          include: {
            service: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.staff.count({ where: whereConditions }),
  ]);

  return {
    meta: {
      page: Number(page),
      limit: Number(limit),
      total,
    },
    data: staff,
  };
};

const getStaffById = async (id: string) => {
  const staff = await prisma.staff.findUnique({
    where: {
      id,
      isDeleted: false,
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          profilePhoto: true,
          gender: true,
        },
      },
      salon: true,
      staffServices: {
        include: {
          service: true,
        },
      },
      reviews: {
        include: {
          customer: {
            select: {
              id: true,
              name: true,
              profilePhoto: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!staff) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Staff not found");
  }

  return staff;
};

const updateStaff = async (ownerId: string, staffId: string, payload: any) => {
  // Verify ownership
  const salonOwner = await prisma.salonOwner.findUnique({
    where: { userId: ownerId },
  });

  if (!salonOwner) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "Only salon owners can update staff"
    );
  }

  const staff = await prisma.staff.findUnique({
    where: {
      id: staffId,
      isDeleted: false,
    },
    include: { salon: true },
  });

  if (!staff) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Staff not found");
  }

  if (staff.salon.ownerId !== salonOwner.id) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "You can only update your own staff"
    );
  }

  const result = await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const { serviceIds, ...updateData } = payload;

      const updatedStaff = await tx.staff.update({
        where: { id: staffId },
        data: updateData,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              profilePhoto: true,
            },
          },
        },
      });

      // Update services if provided
      if (serviceIds) {
        // Remove existing services
        await tx.staffService.deleteMany({
          where: { staffId },
        });

        // Add new services
        if (serviceIds.length > 0) {
          await tx.staffService.createMany({
            data: serviceIds.map((serviceId: string) => ({
              staffId,
              serviceId,
            })),
          });
        }
      }

      return updatedStaff;
    }
  );

  return result;
};

const removeStaff = async (ownerId: string, staffId: string) => {
  // Verify ownership
  const salonOwner = await prisma.salonOwner.findUnique({
    where: { userId: ownerId },
  });

  if (!salonOwner) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "Only salon owners can remove staff"
    );
  }

  const staff = await prisma.staff.findUnique({
    where: {
      id: staffId,
      isDeleted: false,
    },
    include: { salon: true },
  });

  if (!staff) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Staff not found");
  }

  if (staff.salon.ownerId !== salonOwner.id) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "You can only remove your own staff"
    );
  }

  // Soft delete and revert user role
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.staff.update({
      where: { id: staffId },
      data: { isDeleted: true },
    });

    await tx.user.update({
      where: { id: staff.userId },
      data: { role: "CUSTOMER" },
    });
  });

  return null;
};

export const StaffService = {
  addStaff,
  getAllStaff,
  getStaffById,
  updateStaff,
  removeStaff,
};
