import { NextFunction, Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import jwt, { JwtPayload } from "jsonwebtoken";
import ApiError from "../Error/error";
import { clientIp } from "../middlewares/rateLimiter";
import prisma from "../shared/prisma";
import { audit, AuditCtx } from "./audit";

/**
 * Read-only "View as": an admin gets a 15-minute access token for a customer,
 * staff member or owner, with `imp: { adminId, until }` (until = epoch ms) and
 * no refresh token. auth() and optionalAuth() pass it through guardImpersonation;
 * the /admin router refuses it outright.
 */
export const IMPERSONATION_MINUTES = 15;
export const IMPERSONATION_READ_ONLY = "IMPERSONATION_READ_ONLY";

export type ImpersonationClaim = { adminId: string; until: number };

export const impersonationOf = (payload: JwtPayload | undefined): ImpersonationClaim | null => {
  const imp = payload?.imp as Partial<ImpersonationClaim> | undefined;
  if (!imp || typeof imp !== "object") return null;
  return { adminId: String(imp.adminId ?? ""), until: Number(imp.until ?? 0) };
};

const READ_METHODS = new Set(["GET", "HEAD"]);

const impersonationCtx = (req: Request, adminId: string, targetUserId: string): AuditCtx => ({
  actorUserId: adminId,
  actorRole: "ADMIN",
  onBehalfOfUserId: targetUserId,
  source: "api",
  ip: clientIp(req),
  userAgent: req.get("user-agent")?.slice(0, 200) ?? null,
  requestId: req.get("x-request-id")?.slice(0, 100) ?? null,
});

/**
 * For a verified token carrying `imp`: only reads, only until `until`, only
 * while the admin who started it is still an active admin. Sets req.auditCtx
 * and writes one `impersonation.request` row (method + path, never a body or
 * query string). Throws ApiError; returns quietly for ordinary tokens.
 */
export const guardImpersonation = async (req: Request, payload: JwtPayload, targetUserId: string) => {
  const imp = impersonationOf(payload);
  if (!imp) return;

  if (!imp.adminId || !(imp.until > Date.now())) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, "This view-as session has ended.");
  }
  if (!READ_METHODS.has(req.method)) {
    throw ApiError.withCode(
      StatusCodes.FORBIDDEN,
      "Read-only view: changes are not allowed while viewing as this user.",
      IMPERSONATION_READ_ONLY,
    );
  }
  const admin = await prisma.user.findFirst({
    where: { id: imp.adminId, role: "ADMIN", status: "ACTIVE", isDeleted: false },
    select: { id: true },
  });
  if (!admin) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, "This view-as session has ended.");
  }

  req.auditCtx = impersonationCtx(req, imp.adminId, targetUserId);
  await audit(req.auditCtx, {
    action: "impersonation.request",
    entityType: "user",
    entityId: targetUserId,
    after: { method: req.method, path: req.originalUrl.split("?")[0].slice(0, 300) },
  });
};

/**
 * Mounted first on /admin: a view-as token never reaches an admin route, even
 * a read. Only decodes - a forged `imp` merely gets its sender refused.
 */
export const rejectImpersonation = (req: Request, _res: Response, next: NextFunction) => {
  let token: unknown = req.headers.authorization || req.cookies?.accessToken;
  if (typeof token === "string" && token.startsWith("Bearer ")) token = token.split(" ")[1];
  const decoded = typeof token === "string" ? jwt.decode(token.trim()) : null;
  if (decoded && typeof decoded === "object" && impersonationOf(decoded)) {
    return next(
      ApiError.withCode(
        StatusCodes.FORBIDDEN,
        "Admin pages are not available while viewing as a user. End the view first.",
        IMPERSONATION_READ_ONLY,
      ),
    );
  }
  next();
};
