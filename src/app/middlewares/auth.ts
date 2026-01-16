import { Request, Response, NextFunction } from "express";
import { StatusCodes } from "http-status-codes";
import ApiError from "../Error/error";
import { jwtHelpers } from "../helper/jwtHelper";
import config from "../../config";
import prisma from "../shared/prisma";

// Middleware to authenticate and authorize users based on JWT and roles
const auth = (...requiredRoles: string[]) => {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = req.headers.authorization || req.cookies.accessToken;

      if (!token) {
        throw new ApiError(StatusCodes.UNAUTHORIZED, "You are not authorized!");
      }

      const verifiedUser = jwtHelpers.verifyToken(token, config.jwt.jwt_secret);

      // Check if user exists and is active
      const user = await prisma.user.findUnique({
        where: {
          id: verifiedUser.userId,
          isDeleted: false,
        },
      });

      if (!user) {
        throw new ApiError(StatusCodes.NOT_FOUND, "User not found!");
      }

      if (user.status !== "ACTIVE") {
        throw new ApiError(
          StatusCodes.FORBIDDEN,
          `User account is ${user.status.toLowerCase()}`
        );
      }

      if (requiredRoles.length && !requiredRoles.includes(verifiedUser.role)) {
        throw new ApiError(StatusCodes.FORBIDDEN, "Forbidden!");
      }

      req.user = verifiedUser;
      next();
    } catch (error) {
      next(error);
    }
  };
};

export default auth;
