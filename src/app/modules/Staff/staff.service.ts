import { StatusCodes } from "http-status-codes";
import { Prisma } from "@prisma/client";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { AuditCtx } from "../../utils/audit";
import { AccessUser, assertSalonPermission } from "../../utils/salonAccess";
import { removeStylistByStaff, TeamService } from "../Team/team.service";

/**
 * Adding a stylist no longer converts someone's account: it sends a STYLIST
 * invitation, and they join when they accept with their own account.
 */
const addStaff = async (
  actor: AccessUser,
  payload: { salonId: string; email: string; name?: string },
  ctx: AuditCtx,
) => TeamService.invite(actor, payload.salonId, { email: payload.email, name: payload.name, role: "STYLIST" }, ctx);

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

const removeStaff = async (user: AccessUser, staffId: string, ctx: AuditCtx) => {
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

  // The stylist's seat goes too, and the account role is re-derived.
  return removeStylistByStaff(staff, user.userId, ctx);
};

export const StaffService = {
  addStaff,
  getAllStaff,
  getStaffById,
  updateStaff,
  removeStaff,
};
