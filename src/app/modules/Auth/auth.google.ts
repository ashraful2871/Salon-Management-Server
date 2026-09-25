import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { OAuth2Client, TokenPayload } from 'google-auth-library';
import { Prisma, User } from '@prisma/client';
import { StatusCodes } from 'http-status-codes';
import ApiError from '../../Error/error';
import prisma from '../../shared/prisma';
import config, { isGoogleEnabled } from '../../../config';
import { authKey } from '../../utils/authKeys';
import { normalizeEmail } from '../../utils/normalizeEmail';
import { sendEmail } from '../../utils/emailSender';
import { getGoogleLinkedNoticeTemplate } from '../../utils/emailTemplates';
import { AuthResult, issueSession, startEmailVerification } from './auth.session';

/**
 * Google sign-in, Authorization Code + PKCE, run entirely on this server. The
 * browser only ever carries the flow token (in an httpOnly cookie Next.js sets)
 * and Google's `code`/`state`; the client secret, the verifier and the ID token
 * never leave here. Accounts are keyed on Google's `sub`, never on the email.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const FLOW_AUDIENCE = 'salon:google-flow';

const client = () =>
  new OAuth2Client(config.google.clientId, config.google.clientSecret, config.google.redirectUri);
const b64url = (b: Buffer) => b.toString('base64url');
// `\` and whitespace too: browsers read `/\evil.com` as `//evil.com`.
const safeRedirect = (r?: string | null) =>
  r && r.startsWith('/') && !r.startsWith('//') && !/[\\\s]/.test(r) ? r : undefined;

const sameString = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const log = (outcome: string, linked?: Linked) =>
  console.log(`[auth.google] outcome=${outcome}${linked ? ` linked=${linked}` : ''}`);

const disabled = () =>
  ApiError.withCode(StatusCodes.NOT_FOUND, 'Google sign-in is not available', 'GOOGLE_DISABLED');
const stateMismatch = () =>
  ApiError.withCode(
    StatusCodes.BAD_REQUEST,
    'Your Google sign-in expired. Please try again.',
    'GOOGLE_STATE_MISMATCH'
  );
const exchangeFailed = () =>
  ApiError.withCode(
    StatusCodes.BAD_REQUEST,
    "Google sign-in didn't complete. Please try again.",
    'GOOGLE_EXCHANGE_FAILED'
  );

type Flow = { st: string; nn: string; cv: string; rd: string | null };

/** `existing`: the Google account was already linked; `new`: linked now to an account we had; `created`: a new account. */
type Linked = 'existing' | 'new' | 'created';

export const startGoogleFlow = ({ redirect }: { redirect?: string | null }) => {
  if (!isGoogleEnabled()) throw disabled();

  const state = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());

  const authorizeUrl =
    AUTH_URL +
    '?' +
    new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: config.google.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
      access_type: 'online',
      include_granted_scopes: 'true',
    }).toString();

  const flow: Flow = { st: state, nn: nonce, cv: verifier, rd: safeRedirect(redirect) ?? null };
  const flowToken = jwt.sign(flow, authKey('oauth-flow'), {
    audience: FLOW_AUDIENCE,
    expiresIn: '10m',
    algorithm: 'HS256',
  });

  return { authorizeUrl, flowToken };
};

const readFlow = (flowToken: string): Flow => {
  // Outside the try: a missing AUTH_OTP_SECRET is a 500, not an expired sign-in.
  const key = authKey('oauth-flow');

  try {
    const p = jwt.verify(flowToken, key, {
      audience: FLOW_AUDIENCE,
      algorithms: ['HS256'],
    }) as JwtPayload;

    if (typeof p.st !== 'string' || typeof p.nn !== 'string' || typeof p.cv !== 'string') {
      throw new Error('malformed flow token');
    }

    return { st: p.st, nn: p.nn, cv: p.cv, rd: typeof p.rd === 'string' ? p.rd : null };
  } catch {
    throw stateMismatch();
  }
};

export const completeGoogleFlow = async ({
  code,
  state,
  flowToken,
  ip,
}: {
  code: string;
  state: string;
  flowToken: string;
  ip?: string | null;
}): Promise<AuthResult> => {
  if (!isGoogleEnabled()) throw disabled();

  try {
    const flow = readFlow(flowToken);
    if (!sameString(state, flow.st)) throw stateMismatch();

    let idToken: string | null | undefined;
    try {
      const { tokens } = await client().getToken({
        code,
        codeVerifier: flow.cv,
        redirect_uri: config.google.redirectUri,
      });
      idToken = tokens.id_token;
    } catch (e) {
      console.error('[auth.google] code exchange failed:', (e as Error).message);
      throw exchangeFailed();
    }
    if (!idToken) throw exchangeFailed();

    let p: TokenPayload | undefined;
    try {
      // Checks the signature against Google's keys, plus iss, aud and exp.
      const ticket = await client().verifyIdToken({ idToken, audience: config.google.clientId });
      p = ticket.getPayload();
    } catch (e) {
      console.error('[auth.google] ID token rejected:', (e as Error).message);
      throw exchangeFailed();
    }

    if (!p || p.nonce !== flow.nn) throw stateMismatch();

    if (p.email_verified !== true || !p.email) {
      throw ApiError.withCode(
        StatusCodes.BAD_REQUEST,
        "Your Google account's email isn't verified.",
        'GOOGLE_EMAIL_UNVERIFIED'
      );
    }

    const { result, linked } = await resolveGoogleAccount({ ...p, email: p.email }, ip);
    log(result.status, linked);

    return { ...result, redirect: flow.rd ?? undefined };
  } catch (e) {
    log(e instanceof ApiError && e.errorCode ? e.errorCode : 'ERROR');
    throw e;
  }
};

const assertAvailable = (user: Pick<User, 'isDeleted' | 'status'>) => {
  if (user.isDeleted || user.status !== 'ACTIVE') {
    throw ApiError.withCode(
      StatusCodes.FORBIDDEN,
      'This account is not active. Contact support.',
      'ACCOUNT_UNAVAILABLE'
    );
  }
};

/**
 * Finds or makes the account behind a verified Google identity. The ID token's
 * payload must already be checked (signature, audience, nonce, email_verified).
 */
const resolveGoogleAccount = async (
  p: TokenPayload & { email: string },
  ip?: string | null,
  retry = true
): Promise<{ result: AuthResult; linked: Linked }> => {
  const email = normalizeEmail(p.email);
  const byProvider = {
    provider_providerUserId: { provider: 'GOOGLE' as const, providerUserId: p.sub },
  };
  const identityData = (userId: string) => ({
    userId,
    provider: 'GOOGLE' as const,
    providerUserId: p.sub,
    email,
  });

  let user: User;
  let linked: Linked;

  try {
    const identity = await prisma.authIdentity.findUnique({
      where: byProvider,
      include: { user: true },
    });

    if (identity) {
      user = identity.user;
      linked = 'existing';
    } else {
      const existing = await prisma.user.findFirst({
        where: { email: { equals: email, mode: 'insensitive' } },
      });

      if (existing) {
        // Checked before linking, so a blocked or deleted account is left untouched.
        assertAvailable(existing);
        linked = 'new';

        if (existing.emailVerified) {
          await prisma.authIdentity.create({ data: identityData(existing.id) });
          await sendEmail(
            existing.email,
            'Google sign-in was added to your account - SalonKhuji',
            getGoogleLinkedNoticeTemplate(existing.name)
          );
        } else {
          // Pre-hijack defence: whoever set this password never proved the
          // inbox, Google just did. Drop the password and bump sessionVersion
          // so their verification tickets die with it.
          await prisma.$transaction([
            prisma.authIdentity.create({ data: identityData(existing.id) }),
            prisma.user.update({
              where: { id: existing.id },
              data: {
                password: null,
                sessionVersion: { increment: 1 },
                ...(config.google.signupRequiresOtp
                  ? {}
                  : { emailVerified: true, emailVerifiedAt: new Date() }),
              },
            }),
          ]);
        }

        user = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
      } else {
        linked = 'created';
        user = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const created = await tx.user.create({
            data: {
              email,
              name: p.name || email.split('@')[0],
              profilePhoto: p.picture ?? null,
              role: 'CUSTOMER',
              password: null,
              emailVerified: !config.google.signupRequiresOtp,
              emailVerifiedAt: config.google.signupRequiresOtp ? null : new Date(),
            },
          });
          await tx.authIdentity.create({ data: identityData(created.id) });
          return created;
        });
      }
    }
  } catch (e) {
    // Two callbacks raced on the same email or sub: the other one won, so this
    // pass will find what it made.
    if (retry && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return resolveGoogleAccount(p, ip, false);
    }
    throw e;
  }

  assertAvailable(user);

  await prisma.authIdentity.update({ where: byProvider, data: { lastUsedAt: new Date() } });

  // A new account while GOOGLE_SIGNUP_REQUIRES_OTP is on, or a reclaimed unverified one.
  if (!user.emailVerified) {
    return { result: await startEmailVerification(user, ip), linked };
  }

  return {
    result: {
      status: 'SIGNED_IN',
      ...issueSession(user),
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    },
    linked,
  };
};
