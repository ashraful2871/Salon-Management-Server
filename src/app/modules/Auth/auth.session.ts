import { StatusCodes } from 'http-status-codes';
import { UserRole, UserStatus } from '@prisma/client';
import ApiError from '../../Error/error';
import { jwtHelpers } from '../../helper/jwtHelper';
import config from '../../../config';
import { sendEmail } from '../../utils/emailSender';
import { getOtpEmailTemplate } from '../../utils/emailTemplates';
import { OTP_TTL_SECONDS, issueOtp, maskEmail, otpTimings } from '../../utils/otp';
import {
  createTicket,
  createTwoFactorTicket,
  TWO_FACTOR_TICKET_SECONDS,
} from '../../utils/verificationTicket';
import { enabledMfaStep } from '../../utils/mfa';

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

/** ADMIN/AGENT with 2FA on: a correct password alone issues no session. */
export type TwoFactorRequired = {
  status: 'TWO_FACTOR_REQUIRED';
  ticket: string;
  expiresIn: number;
  redirect?: string;
};

export type AuthResult = SignedIn | VerificationRequired | TwoFactorRequired;

/** Admin and agent sessions must sign in again 12 h after the original sign-in. */
export const ADMIN_SESSION_MAX_SECONDS = 12 * 60 * 60;

export const isStaffAccount = (role: UserRole | string) =>
  role === 'ADMIN' || role === 'AGENT';

/**
 * The one place an access/refresh token pair is minted. Both carry the user's
 * `sessionVersion` as `sv`, so bumping the column ends every older session.
 */
export const issueSession = (user: {
  id: string;
  email: string;
  name?: string | null;
  role: UserRole | string;
  sessionVersion: number;
}, opts: { at?: number } = {}) => {
  // `name` is display-only: the frontend verifies the token locally and shows
  // it in the header. It is a snapshot, so a rename shows after the next
  // refresh; nothing authorizes on it.
  const jwtPayload = {
    userId: user.id,
    email: user.email,
    ...(user.name ? { name: user.name } : {}),
    role: user.role,
    sv: user.sessionVersion,
  };

  const accessToken = jwtHelpers.createToken(
    jwtPayload,
    config.jwt.jwt_secret as string,
    config.jwt.expires_in as string
  );

  // `at` is when this sign-in happened, carried forward by every refresh, so
  // the 12 h admin cap counts from the password, not from the last refresh.
  const refreshToken = jwtHelpers.createToken(
    { ...jwtPayload, at: opts.at ?? Math.floor(Date.now() / 1000) },
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

/**
 * The second-factor step for ADMIN/AGENT accounts with 2FA enabled: returns a
 * TWO_FACTOR_REQUIRED result to hand back instead of a session, or null when
 * the account signs in directly. Every sign-in path must ask before issuing.
 */
export const twoFactorGate = async (user: {
  id: string;
  role: UserRole | string;
  sessionVersion: number;
}): Promise<TwoFactorRequired | null> => {
  if (!isStaffAccount(user.role)) return null;
  const mfa = await enabledMfaStep(user.id);
  if (!mfa) return null;
  return {
    status: 'TWO_FACTOR_REQUIRED',
    ticket: createTwoFactorTicket({
      userId: user.id,
      sessionVersion: user.sessionVersion,
      lastUsedStep: mfa.step,
    }),
    expiresIn: TWO_FACTOR_TICKET_SECONDS,
  };
};
