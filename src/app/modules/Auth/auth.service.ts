import bcrypt from 'bcryptjs';
import { StatusCodes } from 'http-status-codes';
import { Prisma, TokenType } from '@prisma/client';
import ApiError from '../../Error/error';
import prisma from '../../shared/prisma';
import { jwtHelpers } from '../../helper/jwtHelper';
import config from '../../../config';
import { sendEmail } from '../../utils/emailSender';
import {
  getEmailChangedNoticeTemplate,
  getEmailVerificationTemplate,
  getPasswordResetTemplate,
} from '../../utils/emailTemplates';
import {
  EMAIL_VERIFY_TTL_HOURS,
  PASSWORD_RESET_TTL_MINUTES,
  RESEND_COOLDOWN_SECONDS,
  consumeToken,
  isWithinCooldown,
  issueToken,
} from '../../utils/verificationToken';

/**
 * Issues an EMAIL_VERIFY token and emails the link. Never throws — a dead SMTP
 * server must not fail the registration it is attached to.
 */
const sendVerificationEmail = async (user: { id: string; email: string; name: string }) => {
  try {
    const rawToken = await issueToken(
      user.id,
      TokenType.EMAIL_VERIFY,
      EMAIL_VERIFY_TTL_HOURS * 60 * 60 * 1000
    );

    const verifyUrl = `${config.frontend_url}/verify-email?token=${rawToken}`;

    await sendEmail(
      user.email,
      'Verify your email - Salon Management',
      getEmailVerificationTemplate(user.name, verifyUrl, EMAIL_VERIFY_TTL_HOURS)
    );
  } catch (error) {
    console.error('Failed to send verification email:', error);
  }
};

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
  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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

  await sendVerificationEmail(result);

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

/**
 * Trades a refresh token for a fresh pair.
 *
 * Both tokens are reissued, not just the access token, so a session slides
 * forward for as long as the user keeps using the site instead of dying on a
 * fixed 90-day wall. The claims are rebuilt from the database row rather than
 * copied out of the old token, so a role or email changed since sign-in is
 * picked up on the next refresh.
 *
 * Every failure here is a 401: the caller's only sensible response to "this
 * session is over" is to drop the cookies and show the signed-out UI, and a
 * 403 or 404 would have it report a different kind of problem to the user.
 */
const refreshToken = async (token: string) => {
  let verifiedUser;

  try {
    verifiedUser = jwtHelpers.verifyToken(
      token,
      config.jwt.refresh_token_secret as string
    );
  } catch {
    throw new ApiError(
      StatusCodes.UNAUTHORIZED,
      'Your session has expired. Please sign in again.'
    );
  }

  const user = await prisma.user.findFirst({
    where: {
      id: verifiedUser.userId,
      isDeleted: false,
    },
  });

  if (!user || user.status !== 'ACTIVE') {
    throw new ApiError(
      StatusCodes.UNAUTHORIZED,
      'Your session is no longer valid. Please sign in again.'
    );
  }

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

  const newRefreshToken = jwtHelpers.createToken(
    jwtPayload,
    config.jwt.refresh_token_secret as string,
    config.jwt.refresh_token_expires_in as string
  );

  return {
    accessToken,
    refreshToken: newRefreshToken,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
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

/**
 * Moves the account to a new address in one step, gated on the current
 * password so a borrowed session cannot take the account over.
 *
 * `User.email` is the only place the address lives - booking confirmations,
 * receipts and resets all read it from the row - so updating it is what makes
 * the new address take effect everywhere. The one copy outside the database is
 * the JWT, which is why a fresh token pair is returned: without it the frontend
 * would keep showing the old address until the next refresh.
 */
const changeEmail = async (
  userId: string,
  payload: { newEmail: string; password: string }
) => {
  const user = await prisma.user.findUnique({
    where: {
      id: userId,
      isDeleted: false,
    },
  });

  if (!user) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
  }

  const isPasswordCorrect = await bcrypt.compare(payload.password, user.password);

  if (!isPasswordCorrect) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'Current password is incorrect');
  }

  const newEmail = payload.newEmail.trim();

  if (newEmail === user.email) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'New email must be different from your current email'
    );
  }

  const existingUser = await prisma.user.findUnique({
    where: { email: newEmail },
    select: { id: true },
  });

  if (existingUser) {
    throw new ApiError(StatusCodes.CONFLICT, 'This email is already in use by another account');
  }

  const oldEmail = user.email;

  // A race with a registration for the same address still ends in a 409: the
  // unique index raises P2002, which the global error handler maps.
  const updatedUser = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Links already sent to the old inbox must stop working. A verify link from
    // there would otherwise mark the new, unconfirmed address as verified.
    await tx.verificationToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });

    return tx.user.update({
      where: { id: userId },
      data: { email: newEmail, emailVerified: false },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        emailVerified: true,
      },
    });
  });

  const jwtPayload = {
    userId: updatedUser.id,
    email: updatedUser.email,
    role: updatedUser.role,
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

  // Neither of these can throw, so a mail outage never undoes the change.
  await Promise.all([
    sendVerificationEmail(updatedUser),
    sendEmail(
      oldEmail,
      'Your email was changed - Salon Management',
      getEmailChangedNoticeTemplate(updatedUser.name, updatedUser.email)
    ),
  ]);

  return {
    user: updatedUser,
    accessToken,
    refreshToken,
  };
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
      emailVerified: true,
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

/**
 * Always resolves, whether or not the email belongs to an account. The
 * controller returns the same 200 either way, so this endpoint cannot be used
 * to discover which addresses are registered.
 */
const forgotPassword = async (payload: { email: string }) => {
  const user = await prisma.user.findUnique({
    where: { email: payload.email },
  });

  if (!user || user.isDeleted || user.status !== 'ACTIVE') {
    return null;
  }

  // Same 60s throttle as resend — stops the endpoint being used as a mail bomb.
  if (await isWithinCooldown(user.id, TokenType.PASSWORD_RESET)) {
    return null;
  }

  const rawToken = await issueToken(
    user.id,
    TokenType.PASSWORD_RESET,
    PASSWORD_RESET_TTL_MINUTES * 60 * 1000
  );

  const resetUrl = `${config.frontend_url}/reset-password?token=${rawToken}`;

  await sendEmail(
    user.email,
    'Reset your password - Salon Management',
    getPasswordResetTemplate(user.name, resetUrl, PASSWORD_RESET_TTL_MINUTES)
  );

  return null;
};

const resetPassword = async (payload: { token: string; newPassword: string }) => {
  const userId = await consumeToken(payload.token, TokenType.PASSWORD_RESET);

  if (!userId) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'This reset link is invalid or has expired. Please request a new one.'
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: userId, isDeleted: false },
  });

  if (!user) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
  }

  const hashedPassword = await bcrypt.hash(payload.newPassword, 12);

  await prisma.user.update({
    where: { id: userId },
    data: { password: hashedPassword },
  });

  return null;
};

const verifyEmail = async (payload: { token: string }) => {
  const userId = await consumeToken(payload.token, TokenType.EMAIL_VERIFY);

  if (!userId) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'This verification link is invalid or has expired. Please request a new one.'
    );
  }

  await prisma.user.update({
    where: { id: userId },
    data: { emailVerified: true },
  });

  return null;
};

/** Like forgotPassword, this resolves silently for unknown or already-verified addresses. */
const resendVerification = async (payload: { email: string }) => {
  const user = await prisma.user.findUnique({
    where: { email: payload.email },
    select: {
      id: true,
      email: true,
      name: true,
      status: true,
      isDeleted: true,
      emailVerified: true,
    },
  });

  if (!user || user.isDeleted || user.status !== 'ACTIVE' || user.emailVerified) {
    return null;
  }

  // Drop the request rather than answering 429: a distinct status here would
  // tell an attacker the address exists and is unverified.
  if (await isWithinCooldown(user.id, TokenType.EMAIL_VERIFY, RESEND_COOLDOWN_SECONDS)) {
    return null;
  }

  await sendVerificationEmail(user);

  return null;
};

export const AuthService = {
  register,
  login,
  refreshToken,
  changePassword,
  changeEmail,
  getMyProfile,
  forgotPassword,
  resetPassword,
  verifyEmail,
  resendVerification,
};
