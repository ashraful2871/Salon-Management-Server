import jwt, { JwtPayload, Secret } from 'jsonwebtoken';

const createToken = (
  // `sv` is the user's sessionVersion when the token was minted; bumping the
  // column ends every session carrying an older one.
  // `at` (refresh tokens only) is when the sign-in happened, for the admin cap.
  // `imp` marks a read-only "View as" token: who started it and when it ends
  // (epoch ms). See utils/impersonation.ts.
  payload: {
    userId: string;
    email: string;
    name?: string;
    role: string;
    sv?: number;
    at?: number;
    imp?: { adminId: string; until: number };
  },
  secret: string,
  expiresIn: string
): string => {
  // Using type assertion for expiresIn due to @types/jsonwebtoken compatibility
  return jwt.sign(payload, secret as Secret, { expiresIn } as any);
};

const verifyToken = (token: string, secret: string): JwtPayload => {
  return jwt.verify(token, secret as Secret) as JwtPayload;
};

export const jwtHelpers = {
  createToken,
  verifyToken,
};
