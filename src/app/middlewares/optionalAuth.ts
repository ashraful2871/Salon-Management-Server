import { Request, Response, NextFunction } from "express";
import { jwtHelpers } from "../helper/jwtHelper";
import config from "../../config";
import prisma from "../shared/prisma";

const optionalAuth = () => {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      let token = req.headers.authorization || req.cookies.accessToken;

      if (!token) {
        return next();
      }

      if (typeof token === "string" && token.startsWith("Bearer ")) {
        token = token.split(" ")[1];
      }

      token = token.trim();

      const verifiedUser = jwtHelpers.verifyToken(token, config.jwt.jwt_secret);

      const user = await prisma.user.findFirst({
        where: {
          id: verifiedUser.userId,
          isDeleted: false,
        },
      });

      if (user && user.status === "ACTIVE") {
        req.user = { ...verifiedUser, role: user.role };
      }
      
      next();
    } catch (error) {
      // If token is invalid or expired, just ignore and proceed as unauthenticated
      next();
    }
  };
};

export default optionalAuth;
