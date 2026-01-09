import bcrypt from 'bcryptjs';
import { StatusCodes } from 'http-status-codes';
import ApiError from '../../Error/error';
import prisma from '../../shared/prisma';
import { jwtHelpers } from '../../helper/jwtHelper';
import config from '../../../config';

const register = async (payload: any) => {
  // Check if user already exists
  const existingUser = await prisma.user.findUnique({
    where: { email: payload.email },
  });

  if (existingUser) {
    throw new ApiError(StatusCodes.CONFLICT, 'User already exists with this email');
  }

  // Hash password
  const hashedPassword = await bcrypt.hash(payload.password, 12);

  // Create user in a transaction
  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: payload.email,
        password: hashedPassword,
        name: payload.name,
        phone: payload.phone,
        gender: payload.gender,
        dateOfBirth: payload.dateOfBirth ? new Date(payload.dateOfBirth) : undefined,
        address: payload.address,
        role: payload.role || 'CUSTOMER',
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
      },
    });

    // If role is SALON_OWNER, create salon owner profile
    if (user.role === 'SALON_OWNER') {
      await tx.salonOwner.create({
        data: {
          userId: user.id,
        },
      });
    }

    return user;
  });

  // Generate tokens
  const jwtPayload = {
    userId: result.id,
    email: result.email,
    role: result.role,
  };

  const accessToken = jwtHelpers.createToken(
    jwtPayload,
    config.jwt.jwt_secret as string,
    config.jwt.expires_in as string
  );

  const refreshToken = jwtHelpers.createToken(
    jwtPayload,
    config.jwt.refresh_token_secret as string,
    config.jwt.refresh_token_expires_in as string
  );

  return {
    user: result,
    accessToken,
    refreshToken,
  };
};

const login = async (payload: { email: string; password: string }) => {
  // Check if user exists
  const user = await prisma.user.findUnique({
    where: {
      email: payload.email,
      isDeleted: false,
    },
  });

  if (!user) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
  }

  // Check if user is active
  if (user.status !== 'ACTIVE') {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      `User account is ${user.status.toLowerCase()}`
    );
  }

  // Check password
  const isPasswordCorrect = await bcrypt.compare(payload.password, user.password);

  if (!isPasswordCorrect) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'Invalid credentials');
  }

  // Generate tokens
  const jwtPayload = {
    userId: user.id,
    email: user.email,
    role: user.role,
  };

  const accessToken = jwtHelpers.createToken(
    jwtPayload,
    config.jwt.jwt_secret as string,
    config.jwt.expires_in as string
  );

  const refreshToken = jwtHelpers.createToken(
    jwtPayload,
    config.jwt.refresh_token_secret as string,
    config.jwt.refresh_token_expires_in as string
  );

  return {
    accessToken,
    refreshToken,
  };
};

const refreshToken = async (token: string) => {
  // Verify token
  const verifiedUser = jwtHelpers.verifyToken(
    token,
    config.jwt.refresh_token_secret as string
  );

  // Check if user exists
  const user = await prisma.user.findUnique({
    where: {
      id: verifiedUser.userId,
      isDeleted: false,
    },
  });

  if (!user) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
  }

  if (user.status !== 'ACTIVE') {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      `User account is ${user.status.toLowerCase()}`
    );
  }

  // Generate new access token
  const jwtPayload = {
    userId: user.id,
    email: user.email,
    role: user.role,
  };

  const accessToken = jwtHelpers.createToken(
    jwtPayload,
    config.jwt.jwt_secret as string,
    config.jwt.expires_in as string
  );

  return {
    accessToken,
  };
};

const changePassword = async (
  userId: string,
  payload: { oldPassword: string; newPassword: string }
) => {
  // Get user
  const user = await prisma.user.findUnique({
    where: {
      id: userId,
      isDeleted: false,
    },
  });

  if (!user) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
  }

  // Check old password
  const isPasswordCorrect = await bcrypt.compare(payload.oldPassword, user.password);

  if (!isPasswordCorrect) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'Old password is incorrect');
  }

  // Hash new password
  const hashedPassword = await bcrypt.hash(payload.newPassword, 12);

  // Update password
  await prisma.user.update({
    where: { id: userId },
    data: { password: hashedPassword },
  });

  return null;
};

const getMyProfile = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: {
      id: userId,
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

export const AuthService = {
  register,
  login,
  refreshToken,
  changePassword,
  getMyProfile,
};
