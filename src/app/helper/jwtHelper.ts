import jwt, { JwtPayload, Secret } from 'jsonwebtoken';

const createToken = (
  // `sv` is the user's sessionVersion when the token was minted; bumping the
  // column ends every session carrying an older one.
  payload: { userId: string; email: string; role: string; sv?: number },
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
