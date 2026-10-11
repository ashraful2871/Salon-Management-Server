import { StatusCodes } from "http-status-codes";
import jwt from "jsonwebtoken";
import config from "../../../../config";
import ApiError from "../../../Error/error";
import { jwtHelpers } from "../../../helper/jwtHelper";
import prisma from "../../../shared/prisma";
import { audit, AuditCtx } from "../../../utils/audit";
import { sendEmail } from "../../../utils/emailSender";
import { getImpersonationNoticeTemplate } from "../../../utils/emailTemplates";
import { IMPERSONATION_MINUTES, impersonationOf } from "../../../utils/impersonation";
import { getSetting } from "../../../utils/settings";
import type { AdminContext } from "../admin.middleware";

const VIEWABLE_ROLES = new Set(["CUSTOMER", "STAFF", "SALON_OWNER"]);

/**
 * A read-only access token for the target: 15 minutes, `imp` claim, no
 * refresh token. Never an ADMIN or AGENT, never yourself, only ACTIVE accounts
 * (auth() would refuse any other).
 */
const start = async (admin: AdminContext, ctx: AuditCtx | undefined, userId: string, reason: string) => {
  const target = await prisma.user.findFirst({
    where: { id: userId, isDeleted: false },
    select: { id: true, name: true, email: true, role: true, status: true, sessionVersion: true },
  });
  if (!target) throw new ApiError(StatusCodes.NOT_FOUND, "User not found");
  if (target.id === admin.userId) {
    throw new ApiError(StatusCodes.FORBIDDEN, "You cannot view as yourself");
  }
  if (!VIEWABLE_ROLES.has(target.role)) {
    throw new ApiError(StatusCodes.FORBIDDEN, "Admin and agent accounts cannot be viewed as");
  }
  if (target.status !== "ACTIVE") {
    throw new ApiError(StatusCodes.CONFLICT, "Only active accounts can be viewed as");
  }

  const until = Date.now() + IMPERSONATION_MINUTES * 60 * 1000;
  const accessToken = jwtHelpers.createToken(
    {
      userId: target.id,
      email: target.email,
      name: target.name,
      role: target.role,
      sv: target.sessionVersion,
      imp: { adminId: admin.userId, until },
    },
    config.jwt.jwt_secret,
    `${IMPERSONATION_MINUTES}m`,
  );

  await audit(ctx, {
    action: "impersonation.start",
    entityType: "user",
    entityId: target.id,
    after: { role: target.role, until: new Date(until) },
    reason,
  });

  if (await getSetting("security.notifyOnImpersonation")) {
    const html = getImpersonationNoticeTemplate({
      name: target.name,
      minutes: IMPERSONATION_MINUTES,
      contactUrl: `${config.frontend_url}/contact`,
    });
    void sendEmail(target.email, "SalonKhuji support viewed your account", html).catch(() => undefined);
  }

  return { accessToken, until, user: { id: target.id, name: target.name, role: target.role } };
};

/**
 * Called with the admin's own session once their cookies are back. `token`
 * (the view-as token being dropped, expired or not) names the user; one the
 * caller did not start is ignored.
 */
const end = async (admin: AdminContext, ctx: AuditCtx | undefined, token?: string) => {
  let userId: string | null = null;
  let until: number | null = null;
  if (token) {
    try {
      const payload = jwt.verify(token, config.jwt.jwt_secret, { ignoreExpiration: true });
      const imp = typeof payload === "object" ? impersonationOf(payload) : null;
      if (imp && imp.adminId === admin.userId) {
        userId = String((payload as jwt.JwtPayload).userId);
        until = imp.until;
      }
    } catch {
      // A bad token still ends the view; the row just names no user.
    }
  }
  await audit(ctx, {
    action: "impersonation.end",
    entityType: "user",
    entityId: userId,
    after: until ? { expired: until <= Date.now() } : null,
  });
  return { userId };
};

export const ImpersonationService = { start, end };
