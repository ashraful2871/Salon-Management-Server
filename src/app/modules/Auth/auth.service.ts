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
  getOtpEmailTemplate,
  getPasswordResetTemplate,
} from '../../utils/emailTemplates';
import {
  PASSWORD_RESET_TTL_MINUTES,
  consumeToken,
  isWithinCooldown,
  issueToken,
} from '../../utils/verificationToken';
import { normalizeEmail } from '../../utils/normalizeEmail';
import {
  OTP_TTL_SECONDS,
  OtpFailure,
  issueOtp,
  maskEmail,
  otpTimings,
  verifyOtp as checkOtp,
} from '../../utils/otp';
import { readTicket } from '../../utils/verificationTicket';
import {
  SignedIn,
  assertCanSignIn,
  issueSession,
  sendVerificationCode,
  startEmailVerification,
} from './auth.session';

/**
 * A cost-12 hash of random bytes nobody kept. Login compares against it when
 * the email is unknown or has no password, so a miss takes as long as a wrong
 * password and the timing does not reveal which addresses are registered.
 */
const DUMMY_HASH = '$2b$12$yPMTE67UgnQIF31ZdHwdtuTO8JnO9dbj/OAJnyXCnlJICEhgDMiYq';

/** Case-insensitive until Phase 6 lower-cases the stored emails. */
const byEmail = (email: string) => ({ equals: email, mode: 'insensitive' as const });

const signedIn = (user: {
  id: string;
  email: string;
  name: string;
  role: SignedIn['user']['role'];
  sessionVersion: number;
}): SignedIn => ({
  status: 'SIGNED_IN',
  ...issueSession(user),
  user: { id: user.id, email: user.email, name: user.name, role: user.role },
});

const register = async (payload: any, ip?: string | null) => {
  const email = normalizeEmail(payload.email);

  // Check if user already exists
  const existingUser = await prisma.user.findFirst({
    where: { email: byEmail(email) },
    select: { id: true },
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
        email,
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
        sessionVersion: true,
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

  if (config.auth.requireEmailVerification) {
    return startEmailVerification(result, ip);
  }

  const { accessToken, refreshToken } = issueSession(result);
  const { sessionVersion: _sessionVersion, ...user } = result;

  return {
    status: 'SIGNED_IN' as const,
    user,
    accessToken,
    refreshToken,
  };
};

/**
 * One 401 for an unknown email, a wrong password and a password-less (Google
 * only) account, with similar timing, so login cannot be used to find out who
 * is registered. The account status is only revealed after the password.
 */
const login = async (payload: { email: string; password: string }, ip?: string | null) => {
  const user = await prisma.user.findFirst({
    where: { email: byEmail(payload.email), isDeleted: false },
  });

  const isPasswordCorrect = user?.password
    ? await bcrypt.compare(payload.password, user.password)
    : (await bcrypt.compare(payload.password, DUMMY_HASH), false);

  if (!user || !isPasswordCorrect) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'Invalid email or password');
  }

  if (user.status !== 'ACTIVE') {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      `User account is ${user.status.toLowerCase()}`
    );
  }

  if (config.auth.requireEmailVerification && !user.emailVerified) {
    return startEmailVerification(user, ip);
  }

  return signedIn(user);
};

const ticketExpired = () =>
  ApiError.withCode(
    StatusCodes.BAD_REQUEST,
    'Your verification session has expired. Please sign in again.',
    'TICKET_EXPIRED'
  );

/**
 * The account a code-screen ticket names, still unverified. A ticket stops
 * working once sessionVersion moves on (sign-out everywhere, email change).
 */
const ticketUser = async (ticket: string) => {
  const { userId, sv } = readTicket(ticket);

  const user = await prisma.user.findFirst({
    where: { id: userId, isDeleted: false },
  });

  if (!user || user.sessionVersion !== sv) {
    throw ticketExpired();
  }

  if (user.emailVerified) {
    throw ApiError.withCode(
      StatusCodes.CONFLICT,
      'Your email is already verified. Please sign in.',
      'ALREADY_VERIFIED'
    );
  }

  return user;
};

const OTP_ERRORS: Record<OtpFailure, { message: string; errorCode: string }> = {
  INVALID: { message: "That code isn't right.", errorCode: 'OTP_INVALID' },
  EXPIRED: { message: 'This code has expired. Request a new one.', errorCode: 'OTP_EXPIRED' },
  LOCKED: { message: 'Too many wrong attempts. Request a new code.', errorCode: 'OTP_LOCKED' },
  NONE: { message: 'No active code. Request a new one.', errorCode: 'OTP_NONE' },
};

const verifyOtp = async (payload: { ticket: string; code: string }) => {
  const user = await ticketUser(payload.ticket);

  const r = await checkOtp({
    userId: user.id,
    purpose: 'EMAIL_VERIFY',
    code: payload.code,
    target: user.email,
  });

  if (!r.ok) {
    const { message, errorCode } = OTP_ERRORS[r.reason];
    throw ApiError.withCode(
      StatusCodes.BAD_REQUEST,
      message,
      errorCode,
      r.reason === 'INVALID' ? { attemptsLeft: r.attemptsLeft } : undefined
    );
  }

  // Conditional, so a parallel success does not move emailVerifiedAt.
  await prisma.user.updateMany({
    where: { id: user.id, emailVerified: false },
    data: { emailVerified: true, emailVerifiedAt: new Date() },
  });

  const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assertCanSignIn(fresh);

  return signedIn(fresh);
};

const resendOtp = async (payload: { ticket: string }, ip?: string | null) => {
  const user = await ticketUser(payload.ticket);

  const issued = await issueOtp({
    userId: user.id,
    purpose: 'EMAIL_VERIFY',
    target: user.email,
    ip,
  });

  if (!issued.ok) {
    throw ApiError.withCode(
      StatusCodes.TOO_MANY_REQUESTS,
      'Please wait before requesting another code',
      'OTP_THROTTLED',
      { retryAfter: issued.retryAfter }
    );
  }

  await sendVerificationCode(user, issued.code);

  const { expiresIn, resendIn } = await otpTimings(user.id, 'EMAIL_VERIFY');

  return { expiresIn, resendIn };
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

  // Same revocation rule as auth(): a bumped sessionVersion ends the session.
  // Every signed-in user is verified with the flag on, so an unverified one
  // here holds a token from before it and must go through the code first.
  if (
    !user ||
    user.status !== 'ACTIVE' ||
    (verifiedUser.sv ?? 0) !== user.sessionVersion ||
    (config.auth.requireEmailVerification && !user.emailVerified)
  ) {
    throw new ApiError(
      StatusCodes.UNAUTHORIZED,
      'Your session is no longer valid. Please sign in again.'
    );
  }

  const { accessToken, refreshToken: newRefreshToken } = issueSession(user);

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
  const isPasswordCorrect = user.password
    ? await bcrypt.compare(payload.oldPassword, user.password)
    : false;

  if (!isPasswordCorrect) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'Old password is incorrect');
  }

  // Hash new password
  const hashedPassword = await bcrypt.hash(payload.newPassword, 12);

  // The bump signs out every other device; this one gets a fresh pair below.
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { password: hashedPassword, sessionVersion: { increment: 1 } },
    select: { id: true, email: true, role: true, sessionVersion: true },
  });

  return issueSession(updated);
};

/**
 * Step 1 of an email change: checks the request and sends a code to the new
 * address. Nothing changes until the code comes back through
 * `confirmEmailChange`, so a typo cannot lock anyone out.
 *
 * The current password is required when the account has one, so a borrowed
 * session cannot move the account; a Google-only account has none to give.
 */
const changeEmail = async (
  userId: string,
  payload: { newEmail: string; password?: string },
  ip?: string | null
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

  if (user.password) {
    const isPasswordCorrect = payload.password
      ? await bcrypt.compare(payload.password, user.password)
      : false;

    if (!isPasswordCorrect) {
      throw new ApiError(StatusCodes.UNAUTHORIZED, 'Current password is incorrect');
    }
  }

  const newEmail = normalizeEmail(payload.newEmail);

  if (newEmail === normalizeEmail(user.email)) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'New email must be different from your current email'
    );
  }

  const existingUser = await prisma.user.findFirst({
    where: { email: byEmail(newEmail) },
    select: { id: true },
  });

  if (existingUser) {
    throw new ApiError(StatusCodes.CONFLICT, 'This email is already in use by another account');
  }

  const issued = await issueOtp({ userId, purpose: 'EMAIL_CHANGE', target: newEmail, ip });

  if (!issued.ok) {
    throw ApiError.withCode(
      StatusCodes.TOO_MANY_REQUESTS,
      'Please wait before requesting another code',
      'OTP_THROTTLED',
      { retryAfter: issued.retryAfter }
    );
  }

  await sendEmail(
    newEmail,
    `${issued.code} is your SalonKhuji code to confirm your new email`,
    getOtpEmailTemplate(user.name, issued.code, OTP_TTL_SECONDS / 60)
  );

  const { expiresIn, resendIn } = await otpTimings(userId, 'EMAIL_CHANGE');

  return { maskedEmail: maskEmail(newEmail), expiresIn, resendIn };
};

/**
 * Step 2: the code proves the new inbox, so the address switches already
 * verified. `User.email` is the only place the address lives, and the JWT is
 * the only copy outside the database, hence the fresh token pair.
 */
const confirmEmailChange = async (userId: string, payload: { code: string }) => {
  const r = await checkOtp({ userId, purpose: 'EMAIL_CHANGE', code: payload.code });

  if (!r.ok) {
    const { message, errorCode } = OTP_ERRORS[r.reason];
    throw ApiError.withCode(
      StatusCodes.BAD_REQUEST,
      message,
      errorCode,
      r.reason === 'INVALID' ? { attemptsLeft: r.attemptsLeft } : undefined
    );
  }

  const inUse = () =>
    new ApiError(StatusCodes.CONFLICT, 'This email is already in use by another account');

  const old = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true },
  });

  let updatedUser;
  try {
    updatedUser = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Someone may have registered the address since the code was sent.
      const taken = await tx.user.findFirst({
        where: { email: byEmail(r.target), NOT: { id: userId } },
        select: { id: true },
      });
      if (taken) throw inUse();

      // Reset links sent to the old inbox must stop working.
      await tx.verificationToken.updateMany({
        where: { userId, usedAt: null },
        data: { usedAt: new Date() },
      });

      // The bump signs out every other device; this one gets a fresh pair below.
      return tx.user.update({
        where: { id: userId },
        data: {
          email: r.target,
          emailVerified: true,
          emailVerifiedAt: new Date(),
          sessionVersion: { increment: 1 },
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          emailVerified: true,
          sessionVersion: true,
        },
      });
    });
  } catch (e) {
    // A registration raced the check above and won the unique index.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw inUse();
    }
    throw e;
  }

  // Cannot throw, so a mail outage never undoes the change.
  await sendEmail(
    old.email,
    'Your email was changed - Salon Management',
    getEmailChangedNoticeTemplate(updatedUser.name, updatedUser.email)
  );

  const { sessionVersion: _sessionVersion, ...user } = updatedUser;

  return { user, ...issueSession(updatedUser) };
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
      password: true,
      authIdentities: { select: { provider: true } },
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

  // The hash is read only to say whether one exists; it never leaves here.
  const { password, authIdentities, ...profile } = user;

  return {
    ...profile,
    hasPassword: Boolean(password),
    signInMethods: [
      ...(password ? ['PASSWORD'] : []),
      ...authIdentities.map((i) => i.provider),
    ],
  };
};

/**
 * Always resolves, whether or not the email belongs to an account. The
 * controller returns the same 200 either way, so this endpoint cannot be used
 * to discover which addresses are registered. A Google-only account (no
 * password) gets the link too: that is how it sets a password.
 */
const forgotPassword = async (payload: { email: string }) => {
  const user = await prisma.user.findFirst({
    where: { email: byEmail(payload.email) },
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

  // The link could only have been opened from that inbox, so it proves the
  // address. The bump ends every session, including whoever knew the old one.
  await prisma.user.update({
    where: { id: userId },
    data: {
      password: hashedPassword,
      sessionVersion: { increment: 1 },
      ...(user.emailVerified ? {} : { emailVerified: true, emailVerifiedAt: new Date() }),
    },
  });

  return null;
};

export const AuthService = {
  register,
  login,
  verifyOtp,
  resendOtp,
  refreshToken,
  changePassword,
  changeEmail,
  confirmEmailChange,
  getMyProfile,
  forgotPassword,
  resetPassword,
};
