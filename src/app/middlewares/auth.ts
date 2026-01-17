import { Request, Response, NextFunction } from "express";
import { StatusCodes } from "http-status-codes";
import ApiError from "../Error/error";
import { jwtHelpers } from "../helper/jwtHelper";
import config from "../../config";
import prisma from "../shared/prisma";

const auth = (...requiredRoles: string[]) => {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      let token = req.headers.authorization || req.cookies.accessToken;

      if (!token) {
        throw new ApiError(StatusCodes.UNAUTHORIZED, "You are not authorized!");
      }

      // ✅ If token comes from header as "Bearer xxx", extract only the real token
      if (typeof token === "string" && token.startsWith("Bearer ")) {
        token = token.split(" ")[1];
      }

      // ✅ extra safety: remove spaces/newlines
      token = token.trim();

      const verifiedUser = jwtHelpers.verifyToken(token, config.jwt.jwt_secret);

      // ✅ Prisma issue: findUnique can't use non-unique filters like isDeleted
      const user = await prisma.user.findFirst({
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
          `User account is ${user.status.toLowerCase()}`,
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
