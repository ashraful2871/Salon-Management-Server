import { StatusCodes } from 'http-status-codes';
import { Prisma } from '@prisma/client';
import ApiError from '../../Error/error';
import prisma from '../../shared/prisma';

const getAllUsers = async (query: any) => {
  const { page = 1, limit = 10, searchTerm, role, status } = query;
  const skip = (Number(page) - 1) * Number(limit);

  const whereConditions: any = {
    isDeleted: false,
  };

  if (searchTerm) {
    whereConditions.OR = [
      { name: { contains: searchTerm, mode: 'insensitive' } },
      { email: { contains: searchTerm, mode: 'insensitive' } },
      { phone: { contains: searchTerm, mode: 'insensitive' } },
    ];
  }

  if (role) {
    whereConditions.role = role;
  }

  if (status) {
    whereConditions.status = status;
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where: whereConditions,
      skip,
      take: Number(limit),
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        phone: true,
        profilePhoto: true,
        gender: true,
        dateOfBirth: true,
        address: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.user.count({ where: whereConditions }),
  ]);

  return {
    meta: {
      page: Number(page),
      limit: Number(limit),
      total,
    },
    data: users,
  };
};

const getUserById = async (id: string) => {
  const user = await prisma.user.findUnique({
    where: {
      id,
      isDeleted: false,
    },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      status: true,
      phone: true,
      profilePhoto: true,
      gender: true,
      dateOfBirth: true,
      address: true,
      createdAt: true,
      updatedAt: true,
      admin: true,
      salonOwner: {
        include: {
          salons: true,
        },
      },
      staff: {
        include: {
          salon: true,
        },
      },
    },
  });

  if (!user) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
  }

  return user;
};

const updateUser = async (id: string, payload: any) => {
  // Check if user exists
  const user = await prisma.user.findUnique({
    where: {
      id,
      isDeleted: false,
    },
  });

  if (!user) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
  }

  const updateData: any = { ...payload };

  if (payload.dateOfBirth) {
    updateData.dateOfBirth = new Date(payload.dateOfBirth);
  }

  const result = await prisma.user.update({
    where: { id },
    data: updateData,
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      status: true,
      phone: true,
      profilePhoto: true,
      gender: true,
      dateOfBirth: true,
      address: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return result;
};

const updateUserStatus = async (id: string, status: string) => {
  // Check if user exists
  const user = await prisma.user.findUnique({
    where: {
      id,
      isDeleted: false,
    },
  });

  if (!user) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
  }

  const result = await prisma.user.update({
    where: { id },
    data: { status: status as any },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      status: true,
      phone: true,
      profilePhoto: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return result;
};

const updateUserRole = async (id: string, role: string) => {
  // Check if user exists
  const user = await prisma.user.findUnique({
    where: {
      id,
      isDeleted: false,
    },
    include: {
      admin: true,
      salonOwner: true,
    },
  });

  if (!user) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
  }

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const updatedUser = await tx.user.update({
      where: { id },
      data: { role: role as any },
    });

    // Handle role-specific profile creation
    if (role === 'SALON_OWNER' && !user.salonOwner) {
      await tx.salonOwner.create({
        data: { userId: id },
      });
    } else if (role === 'ADMIN' && !user.admin) {
      await tx.admin.create({
        data: { userId: id },
      });
    }

    return updatedUser;
  });

  return result;
};

const deleteUser = async (id: string) => {
  // Check if user exists
  const user = await prisma.user.findUnique({
    where: {
      id,
      isDeleted: false,
    },
  });

  if (!user) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
  }

  // Soft delete
  await prisma.user.update({
    where: { id },
    data: {
      isDeleted: true,
      status: 'DELETED',
    },
  });

  return null;
};

export const UserService = {
  getAllUsers,
  getUserById,
  updateUser,
  updateUserStatus,
  updateUserRole,
  deleteUser,
};
