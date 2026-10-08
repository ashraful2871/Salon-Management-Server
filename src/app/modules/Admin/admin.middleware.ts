import { NextFunction, Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import auth from "../../middlewares/auth";
import { adminSensitiveLimiter, clientIp } from "../../middlewares/rateLimiter";
import prisma from "../../shared/prisma";
import type { AuditCtx } from "../../utils/audit";
import { openStepUp, verifyCode } from "../../utils/mfa";
import { normalizeArea, Permission, permissionsFor } from "./admin.permissions";
import type { AdminRole } from "@prisma/client";

export type AdminContext = {
  userId: string;
  accountRole: "ADMIN" | "AGENT";
  adminRole?: AdminRole;
  permissions: Permission[];
  /** AGENT only: the area they may review, as typed on their profile. */
  area?: string;
  /** TOTP 2FA enabled. Without it only /admin/me and /admin/mfa/* answer. */
  mfaEnabled: boolean;
};

export const buildAuditCtx = (req: Request, actorRole: string): AuditCtx => ({
  actorUserId: req.user?.userId ?? null,
  actorRole,
  source: "api",
  ip: clientIp(req),
  userAgent: req.get("user-agent")?.slice(0, 200) ?? null,
  requestId: req.get("x-request-id")?.slice(0, 100) ?? null,
});

/**
 * Loads the caller's admin or agent profile once per request onto req.admin
 * and req.auditCtx. Expects auth() to have run. An ADMIN without an admins
 * row, or an AGENT without an agents row, gets no permissions at all.
 */
export const loadAdminContext = async (req: Request): Promise<AdminContext> => {
  if (req.admin) return req.admin;

  const userId: string | undefined = req.user?.userId;
  const role: string | undefined = req.user?.role;
  if (!userId || (role !== "ADMIN" && role !== "AGENT")) {
    throw new ApiError(StatusCodes.FORBIDDEN, "Forbidden");
  }

  const mfa = await prisma.userMfa.findUnique({
    where: { userId },
    select: { enabledAt: true },
  });
  const mfaEnabled = !!mfa?.enabledAt;

  let ctx: AdminContext;
  if (role === "ADMIN") {
    const admin = await prisma.admin.findUnique({
      where: { userId },
      select: { adminRole: true },
    });
    ctx = {
      userId,
      accountRole: "ADMIN",
      adminRole: admin?.adminRole,
      permissions: admin ? permissionsFor("ADMIN", admin.adminRole) : [],
      mfaEnabled,
    };
  } else {
    const agent = await prisma.agent.findUnique({
      where: { userId },
      select: { area: true },
    });
    ctx = {
      userId,
      accountRole: "AGENT",
      permissions: agent ? permissionsFor("AGENT") : [],
      area: agent?.area,
      mfaEnabled,
    };
  }

  req.admin = ctx;
  req.auditCtx = buildAuditCtx(req, ctx.adminRole ?? ctx.accountRole);
  return ctx;
};

const assertHolds = (ctx: AdminContext, required: Permission[]) => {
  if (!required.every((p) => ctx.permissions.includes(p))) {
    throw new ApiError(StatusCodes.FORBIDDEN, "Forbidden");
  }
};

const assertMfa = (ctx: AdminContext) => {
  if (!ctx.mfaEnabled) {
    throw ApiError.withCode(
      StatusCodes.FORBIDDEN,
      "Set up two-factor sign-in to use the admin console.",
      "TWO_FACTOR_SETUP_REQUIRED",
    );
  }
};

const requireAdminOrAgent = auth("ADMIN", "AGENT");

export type AdminGateOptions = {
  required?: Permission[];
  /**
   * Paths (relative to the router this gate is mounted on) that answer before
   * 2FA is set up: "/me" matches exactly, "/mfa/" as a prefix. Only for the
   * screens that let an account enrol.
   */
  mfaExempt?: string[];
};

const isExempt = (path: string, exempt: string[]) =>
  exempt.some((e) => (e.endsWith("/") ? path.startsWith(e) : path === e || path === `${e}/`));

/** adminAuth() with options; see AdminGateOptions. */
export const adminGate = ({ required = [], mfaExempt = [] }: AdminGateOptions) => {
  const check = async (req: Request, next: NextFunction) => {
    try {
      const ctx = await loadAdminContext(req);
      if (!isExempt(req.path, mfaExempt)) assertMfa(ctx);
      assertHolds(ctx, required);
      next();
    } catch (error) {
      next(error);
    }
  };

  return (req: Request, res: Response, next: NextFunction) => {
    if (req.admin) return void check(req, next);
    requireAdminOrAgent(req, res, (err?: unknown) => {
      if (err) return next(err);
      void check(req, next);
    });
  };
};

/**
 * The gate for every admin route: auth("ADMIN","AGENT"), 2FA enabled, then
 * every listed permission must be held. Cheap to stack - the profile is
 * loaded once.
 */
export const adminAuth = (...required: Permission[]) => adminGate({ required });

/**
 * For routes shared with non-admin roles (they keep plain auth(...)): when
 * the caller is an ADMIN, require `permission`. Other roles pass untouched -
 * their own ownership checks still apply in the service.
 */
export const assertAdminPermission = async (
  req: Request,
  permission: Permission,
): Promise<void> => {
  if (req.user?.role !== "ADMIN") return;
  const ctx = await loadAdminContext(req);
  assertMfa(ctx);
  assertHolds(ctx, [permission]);
};

/** The normalised area an AGENT is confined to, or null for admins. */
export const agentScope = (req: Request): string | null =>
  req.admin?.accountRole === "AGENT" && req.admin.area
    ? normalizeArea(req.admin.area)
    : null;

/**
 * After adminAuth(): ADMIN accounts only. For admin-only screens whose
 * permission an AGENT also holds (agents review salons, not owner
 * applications).
 */
export const adminOnly = (req: Request, _res: Response, next: NextFunction) =>
  next(
    req.admin?.accountRole === "ADMIN"
      ? undefined
      : new ApiError(StatusCodes.FORBIDDEN, "Forbidden"),
  );

const isStaff = (req: Request) =>
  req.user?.role === "ADMIN" || req.user?.role === "AGENT";

/**
 * adminSensitiveLimiter for routes shared with salon owners: only admin and
 * agent callers count against it.
 */
export const adminSensitiveForStaff = (req: Request, res: Response, next: NextFunction) =>
  isStaff(req) ? adminSensitiveLimiter(req, res, next) : next();

/**
 * Tier-3 routes: the caller must have confirmed a fresh authenticator code.
 * Passes while the step-up window (10 min) is open; otherwise a valid
 * X-Step-Up-Code header opens it; otherwise 403 STEP_UP_REQUIRED, which the
 * frontend answers with the step-up dialog and one retry. Non-staff callers on
 * shared routes pass untouched. Mount after auth()/adminAuth().
 */
export const requireStepUp =
  () => async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!isStaff(req)) return next();
      const userId: string = req.user!.userId;

      const mfa = await prisma.userMfa.findUnique({
        where: { userId },
        select: { enabledAt: true, stepUpUntil: true },
      });
      if (!mfa?.enabledAt) {
        throw ApiError.withCode(
          StatusCodes.FORBIDDEN,
          "Set up two-factor sign-in to use the admin console.",
          "TWO_FACTOR_SETUP_REQUIRED",
        );
      }
      if (mfa.stepUpUntil && mfa.stepUpUntil > new Date()) return next();

      const code = req.get("x-step-up-code")?.trim();
      if (code) {
        await verifyCode(userId, code);
        await openStepUp(userId);
        return next();
      }

      throw ApiError.withCode(
        StatusCodes.FORBIDDEN,
        "Confirm this action with a code from your authenticator app.",
        "STEP_UP_REQUIRED",
      );
    } catch (error) {
      next(error);
    }
  };
