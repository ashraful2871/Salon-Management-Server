import { Request, Response, NextFunction } from "express";
import { JwtPayload } from "jsonwebtoken";
import { jwtHelpers } from "../helper/jwtHelper";
import config from "../../config";
import prisma from "../shared/prisma";
import ApiError from "../Error/error";
import { guardImpersonation } from "../utils/impersonation";

const optionalAuth = () => {
  return async (req: Request, _res: Response, next: NextFunction) => {
    let verifiedUser: JwtPayload;
    try {
      let token = req.headers.authorization || req.cookies.accessToken;

      if (!token) {
        return next();
      }

      if (typeof token === "string" && token.startsWith("Bearer ")) {
        token = token.split(" ")[1];
      }

      token = token.trim();

      verifiedUser = jwtHelpers.verifyToken(token, config.jwt.jwt_secret);
    } catch (error) {
      // If token is invalid or expired, just ignore and proceed as unauthenticated
      return next();
    }

    try {
      const user = await prisma.user.findFirst({
        where: {
          id: verifiedUser.userId,
          isDeleted: false,
        },
      });

      // A revoked session (see auth.ts) is treated as a visitor.
      if (
        user &&
        user.status === "ACTIVE" &&
        (verifiedUser.sv ?? 0) === user.sessionVersion
      ) {
        // A "View as" token is refused here too, not downgraded to a visitor:
        // a write must never go through as a guest on the user's behalf.
        await guardImpersonation(req, verifiedUser, user.id);
        req.user = { ...verifiedUser, email: user.email, role: user.role };
      }

      next();
    } catch (error) {
      // Only a view-as refusal is passed on; anything else stays a visitor.
      next(error instanceof ApiError ? error : undefined);
    }
  };
};

export default optionalAuth;
