import { StatusCodes } from "http-status-codes";
import { Prisma, UserRole } from "@prisma/client";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { AccessUser, assertSalonPermission } from "../../utils/salonAccess";

const addStaff = async (actor: AccessUser, payload: any) => {
  await assertSalonPermission(actor, payload.salonId, "team.invite");

  // Check if user exists
  const user = await prisma.user.findUnique({
    where: {
      email: payload.email,
      isDeleted: false,
    },
  });

  if (!user) {
    throw new ApiError(StatusCodes.NOT_FOUND, "User not found");
  }

  // Check if user is already staff somewhere
  const existingStaff = await prisma.staff.findUnique({
    where: { userId: user.id },
  });

  if (existingStaff) {
    throw new ApiError(StatusCodes.CONFLICT, "User is already a staff member");
  }

  // Create staff in transaction
  const result = await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      // Update user role to STAFF
      await tx.user.update({
        where: { id: user.id },
        data: { role: UserRole.STAFF },
      });

      // Create staff record
      const staff = await tx.staff.create({
        data: {
          userId: user.id,
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
    },
  );

  return result;
};

const getAllStaff = async (query: any, user?: any) => {
  const { page = 1, limit = 10, salonId, status } = query;
  const skip = (Number(page) - 1) * Number(limit);

  const whereConditions: any = {
    isDeleted: false,
  };

  if (user?.role === "AGENT") {
    const agent = await prisma.agent.findUnique({
      where: { userId: user.userId },
      select: { area: true },
    });
    
    if (agent) {
      whereConditions.salon = { area: agent.area };
    }
  }

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
        where: { status: "PUBLISHED" },
        omit: { ownerReplyById: true },
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

const updateStaff = async (user: AccessUser, staffId: string, payload: any) => {
  const staff = await prisma.staff.findUnique({
    where: {
      id: staffId,
      isDeleted: false,
    },
  });

  if (!staff) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Staff not found");
  }

  await assertSalonPermission(user, staff.salonId, "team.invite");

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
    },
  );

  return result;
};

const removeStaff = async (user: AccessUser, staffId: string) => {
  const staff = await prisma.staff.findUnique({
    where: {
      id: staffId,
      isDeleted: false,
    },
  });

  if (!staff) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Staff not found");
  }

  await assertSalonPermission(user, staff.salonId, "team.invite");

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
