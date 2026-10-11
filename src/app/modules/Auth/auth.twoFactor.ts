import { StatusCodes } from 'http-status-codes';
import ApiError from '../../Error/error';
import prisma from '../../shared/prisma';
import { useRecoveryCode, verifyCode } from '../../utils/mfa';
import { readTwoFactorTicket } from '../../utils/verificationTicket';
import { audit, AuditCtx } from '../../utils/audit';
import { SignedIn, assertCanSignIn, issueSession } from './auth.session';

/**
 * Second step of an ADMIN/AGENT sign-in: the ticket from login (or the Google
 * callback) plus an authenticator code or one recovery code. Issues the
 * session exactly as a normal login does. The ticket is single use: any
 * accepted code moves lastUsedStep past the value it pins.
 */
export const verifyTwoFactor = async (
  payload: { ticket: string; code?: string; recoveryCode?: string },
  ctx: Omit<AuditCtx, 'actorUserId' | 'actorRole'>
): Promise<SignedIn & { recoveryCodesLeft?: number }> => {
  const { userId, sv, ls } = readTwoFactorTicket(payload.ticket);

  const user = await prisma.user.findFirst({ where: { id: userId, isDeleted: false } });
  if (!user || user.sessionVersion !== sv) {
    throw ApiError.withCode(
      StatusCodes.BAD_REQUEST,
      'Your sign-in has expired. Please sign in again.',
      'TICKET_EXPIRED'
    );
  }
  assertCanSignIn(user);

  let recoveryCodesLeft: number | undefined;
  if (payload.recoveryCode) {
    recoveryCodesLeft = (await useRecoveryCode(user.id, payload.recoveryCode, { ticketStep: ls }))
      .remaining;
    await audit(
      { ...ctx, actorUserId: user.id, actorRole: user.role },
      { action: 'mfa.recovery_used', entityType: 'user', entityId: user.id, after: { recoveryCodesLeft } }
    );
  } else {
    await verifyCode(user.id, payload.code ?? '', { ticketStep: ls });
  }

  return {
    status: 'SIGNED_IN',
    ...issueSession(user),
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    ...(recoveryCodesLeft !== undefined ? { recoveryCodesLeft } : {}),
  };
};
