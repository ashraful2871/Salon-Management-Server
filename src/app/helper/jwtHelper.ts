import jwt, { JwtPayload } from 'jsonwebtoken';

const createToken = (
  payload: { userId: string; email: string; role: string },
  secret: string,
  expiresIn: string
): string => {
  return jwt.sign(payload, secret, { expiresIn: expiresIn as any });
};

const verifyToken = (token: string, secret: string): JwtPayload => {
  return jwt.verify(token, secret) as JwtPayload;
};

export const jwtHelpers = {
  createToken,
  verifyToken,
};
