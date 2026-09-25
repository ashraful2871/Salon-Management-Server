import { StatusCodes } from 'http-status-codes';
import { UserRole, UserStatus } from '@prisma/client';
import ApiError from '../../Error/error';
import { jwtHelpers } from '../../helper/jwtHelper';
import config from '../../../config';
import { sendEmail } from '../../utils/emailSender';
import { getOtpEmailTemplate } from '../../utils/emailTemplates';
import { OTP_TTL_SECONDS, issueOtp, maskEmail, otpTimings } from '../../utils/otp';
import { createTicket } from '../../utils/verificationTicket';

export type SignedIn = {
  status: 'SIGNED_IN';
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; name: string; role: UserRole };
  redirect?: string;
};

export type VerificationRequired = {
  status: 'VERIFICATION_REQUIRED';
  ticket: string;
  maskedEmail: string;
  expiresIn: number;
  resendIn: number;
  redirect?: string;
};

export type AuthResult = SignedIn | VerificationRequired;

/**
 * The one place an access/refresh token pair is minted. Both carry the user's
 * `sessionVersion` as `sv`, so bumping the column ends every older session.
 */
export const issueSession = (user: {
  id: string;
  email: string;
  role: UserRole | string;
  sessionVersion: number;
}) => {
  const jwtPayload = {
    userId: user.id,
    email: user.email,
    role: user.role,
    sv: user.sessionVersion,
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

  return { accessToken, refreshToken };
};

/**
 * Whether this account may be handed a session at all. Callers that can offer
 * a code instead check `emailVerified` themselves first; the last check is a
 * safety net for a path that forgot to.
 */
export const assertCanSignIn = (user: {
  isDeleted: boolean;
  status: UserStatus;
  emailVerified: boolean;
}) => {
  if (user.isDeleted) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'Invalid email or password');
  }

  if (user.status !== 'ACTIVE') {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      `User account is ${user.status.toLowerCase()}`
    );
  }

  if (config.auth.requireEmailVerification && !user.emailVerified) {
    throw ApiError.withCode(
      StatusCodes.FORBIDDEN,
      'Please verify your email address to continue.',
      'EMAIL_NOT_VERIFIED'
    );
  }
};

/** Emails a freshly issued sign-up code. Never throws (sendEmail doesn't). */
export const sendVerificationCode = (user: { email: string; name: string }, code: string) =>
  sendEmail(
    user.email,
    `${code} is your SalonKhuji verification code`,
    getOtpEmailTemplate(user.name, code, OTP_TTL_SECONDS / 60)
  );

/**
 * Sends a sign-up code (unless one was sent too recently, in which case the
 * existing one stays valid) and returns what the code screen needs. A mail
 * outage does not fail the request: the user can ask for another code.
 */
export const startEmailVerification = async (
  user: { id: string; email: string; name: string; sessionVersion: number },
  ip?: string | null
): Promise<VerificationRequired> => {
  const issued = await issueOtp({
    userId: user.id,
    purpose: 'EMAIL_VERIFY',
    target: user.email,
    ip,
  });

  if (issued.ok) {
    await sendVerificationCode(user, issued.code);
  }

  const t = await otpTimings(user.id, 'EMAIL_VERIFY');

  return {
    status: 'VERIFICATION_REQUIRED',
    ticket: createTicket({ userId: user.id, sessionVersion: user.sessionVersion }),
    maskedEmail: maskEmail(user.email),
    ...t,
  };
};
