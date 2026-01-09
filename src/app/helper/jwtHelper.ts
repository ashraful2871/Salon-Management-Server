import jwt, { JwtPayload, Secret } from 'jsonwebtoken';

const createToken = (
  payload: { userId: string; email: string; role: string },
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
