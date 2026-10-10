import { Request, Response, NextFunction } from "express";
import { StatusCodes } from "http-status-codes";
import ApiError from "../Error/error";
import { jwtHelpers } from "../helper/jwtHelper";
import config from "../../config";
import prisma from "../shared/prisma";
import { guardImpersonation } from "../utils/impersonation";

const ACTIVE_STAMP_MS = 15 * 60 * 1000;

/**
 * Stamps lastActiveAt at most every 15 minutes. The conditional where makes
 * concurrent requests write once; fire and forget, never blocks the request.
 */
const touchLastActive = (userId: string, lastActiveAt: Date | null) => {
  const cutoff = new Date(Date.now() - ACTIVE_STAMP_MS);
  if (lastActiveAt && lastActiveAt >= cutoff) return;
  prisma.user
    .updateMany({
      where: { id: userId, OR: [{ lastActiveAt: null }, { lastActiveAt: { lt: cutoff } }] },
      data: { lastActiveAt: new Date() },
    })
    .catch(() => undefined);
};

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

      // A password change or reset, a block, or a Google reclaim bumps
      // sessionVersion. Tokens from before `sv` existed count as 0, which
      // matches every account that was never bumped.
      if ((verifiedUser.sv ?? 0) !== user.sessionVersion) {
        throw new ApiError(
          StatusCodes.UNAUTHORIZED,
          "Your session has ended. Please sign in again.",
        );
      }

      if (user.status !== "ACTIVE") {
        throw new ApiError(
          StatusCodes.FORBIDDEN,
          `User account is ${user.status.toLowerCase()}`,
        );
      }

      // ✅ Use user.role from the database instead of the potentially stale token role
      if (requiredRoles.length && !requiredRoles.includes(user.role)) {
        throw new ApiError(StatusCodes.FORBIDDEN, "Forbidden!");
      }

      // A "View as" token: reads only, until it ends, one audit row each.
      await guardImpersonation(req, verifiedUser, user.id);

      // Update the request user with the fresh role and email from DB - both can
      // change after the token was issued
      req.user = { ...verifiedUser, email: user.email, role: user.role };
      // Support looking around is not the user being active.
      if (!verifiedUser.imp) touchLastActive(user.id, user.lastActiveAt);
      next();
    } catch (error) {
      next(error);
    }
  };
};

export default auth;
