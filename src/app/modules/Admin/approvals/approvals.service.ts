import { ApprovalStatus, Prisma } from "@prisma/client";
import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import config from "../../../../config";
import ApiError from "../../../Error/error";
import prisma from "../../../shared/prisma";
import sendResponse from "../../../shared/sendResponse";
import { audit, AuditCtx } from "../../../utils/audit";
import { sendEmail } from "../../../utils/emailSender";
import { getApprovalRequestTemplate } from "../../../utils/emailTemplates";
import { getSetting } from "../../../utils/settings";
import { AdminContext } from "../admin.middleware";
import { can, permissionsFor } from "../admin.permissions";
import { actionDef, ApprovalAction, isApprovalAction } from "./approvals.actions";

const DAY = 24 * 60 * 60 * 1000;

/** JSON-safe copy of a service result (Dates become strings) for `result`. */
const toJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value ?? null)) ?? {};

/** Emails every other admin who could approve it. Never throws. */
const notifyApprovers = async (
  approval: { id: string; action: ApprovalAction; summary: string; reason: string },
  permission: string,
  requestedById: string,
) => {
  try {
    const [requester, admins] = await Promise.all([
      prisma.user.findUnique({ where: { id: requestedById }, select: { name: true } }),
      prisma.admin.findMany({
        where: {
          userId: { not: requestedById },
          user: { role: "ADMIN", isDeleted: false, status: "ACTIVE" },
        },
        select: { adminRole: true, user: { select: { email: true } } },
      }),
    ]);
    const to = admins
      .filter((a) => permissionsFor("ADMIN", a.adminRole).includes(permission as never))
      .map((a) => a.user.email);
    const url = `${config.frontend_url}/dashboard/admin/finance/approvals`;
    const html = getApprovalRequestTemplate(
      requester?.name ?? "An admin",
      approval.summary,
      approval.reason,
      url,
    );
    const results = await Promise.all(
      to.map((email) => sendEmail(email, `Approval needed: ${approval.summary}`, html)),
    );
    console.log(
      `[approvals] ${approval.action} ${approval.id}: notified ${results.filter((r) => r.ok).length}/${to.length} admin(s)`,
    );
  } catch (error) {
    console.error("[approvals] notify failed", error);
  }
};

/**
 * The four-eyes gate a direct money route calls before doing the work. When
 * `approvals.enabled` is on and `condition` holds, it records a PENDING
 * approval, answers `202 { status: "APPROVAL_REQUIRED", approvalId }` and
 * returns true - the route must then stop. Otherwise false, and the route
 * carries on as usual.
 */
export const requireApprovalIf = async (
  req: Request,
  res: Response,
  action: ApprovalAction,
  condition: boolean | (() => boolean | Promise<boolean>),
  request: { payload: Record<string, unknown>; summary: string; reason: string },
): Promise<boolean> => {
  if (!(await getSetting("approvals.enabled"))) return false;
  const holds = typeof condition === "function" ? await condition() : condition;
  if (!holds) return false;

  const requestedById = req.user!.userId;
  const reason = request.reason.trim();
  if (!reason) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "A reason is required for a change that needs approval");
  }

  const approval = await prisma.adminApproval.create({
    data: {
      action,
      payload: toJson(request.payload),
      summary: request.summary.slice(0, 300),
      requestedById,
      reason: reason.slice(0, 500),
      expiresAt: new Date(Date.now() + DAY),
    },
  });

  await audit(req.auditCtx, {
    action: "approval.request",
    entityType: "approval",
    entityId: approval.id,
    after: { action, summary: approval.summary },
    reason,
  });

  void notifyApprovers(
    { id: approval.id, action, summary: approval.summary, reason: approval.reason },
    actionDef(action).permission(request.payload),
    requestedById,
  );

  sendResponse(res, {
    statusCode: StatusCodes.ACCEPTED,
    success: true,
    message: "Sent for approval",
    data: { status: "APPROVAL_REQUIRED", approvalId: approval.id },
  });
  return true;
};

/** The thresholds the direct routes compare against. */
export const approvalThresholds = async () => ({
  walletAdjustOverMinor: await getSetting("approvals.walletAdjustOverMinor"),
  refundOverMinor: await getSetting("approvals.refundOverMinor"),
});

// ---------------------------------------------------------------- list

const STATUSES = Object.values(ApprovalStatus) as string[];

const list = async (admin: AdminContext, query: Record<string, unknown>) => {
  const raw = typeof query.status === "string" ? query.status.toUpperCase() : "PENDING";
  if (raw !== "ALL" && !STATUSES.includes(raw)) {
    throw new ApiError(StatusCodes.BAD_REQUEST, `Unknown status "${query.status}"`);
  }

  const rows = await prisma.adminApproval.findMany({
    where: raw === "ALL" ? {} : { status: raw as ApprovalStatus },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  // An admin sees what they could decide, plus what they asked for.
  const visible = rows.filter((row) => {
    if (row.requestedById === admin.userId) return true;
    if (!isApprovalAction(row.action)) return false;
    return can(admin, actionDef(row.action).permission(row.payload as Record<string, unknown>));
  });

  const ids = [...new Set(visible.flatMap((r) => [r.requestedById, r.decidedById]).filter(Boolean))] as string[];
  const people = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, email: true },
  });
  const byId = new Map(people.map((p) => [p.id, p]));

  const [enabled, pendingCount] = await Promise.all([
    getSetting("approvals.enabled"),
    prisma.adminApproval.count({ where: { status: ApprovalStatus.PENDING, expiresAt: { gt: new Date() } } }),
  ]);

  return {
    enabled,
    pendingCount,
    items: visible.map((row) => {
      const mine = row.requestedById === admin.userId;
      const permitted =
        isApprovalAction(row.action) &&
        can(admin, actionDef(row.action).permission(row.payload as Record<string, unknown>));
      return {
        id: row.id,
        action: row.action,
        summary: row.summary,
        reason: row.reason,
        status: row.status,
        payload: row.payload,
        requestedBy: byId.get(row.requestedById) ?? null,
        decidedBy: row.decidedById ? (byId.get(row.decidedById) ?? null) : null,
        decidedAt: row.decidedAt,
        decisionNote: row.decisionNote,
        executedAt: row.executedAt,
        error: row.error,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        mine,
        canDecide: !mine && permitted && row.status === ApprovalStatus.PENDING && row.expiresAt > new Date(),
      };
    }),
  };
};

// ---------------------------------------------------------------- decide

const loadForDecision = async (admin: AdminContext, id: string) => {
  const approval = await prisma.adminApproval.findUnique({ where: { id } });
  if (!approval || !isApprovalAction(approval.action)) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Approval not found");
  }
  const def = actionDef(approval.action);
  if (!can(admin, def.permission(approval.payload as Record<string, unknown>))) {
    throw new ApiError(StatusCodes.FORBIDDEN, "You don't hold the permission this action needs");
  }
  return { approval, def };
};

const approve = async (
  admin: AdminContext,
  ctx: AuditCtx | undefined,
  id: string,
  note?: string,
) => {
  const { approval, def } = await loadForDecision(admin, id);

  if (approval.requestedById === admin.userId) {
    throw new ApiError(StatusCodes.FORBIDDEN, "You can't approve your own request");
  }

  // The claim: only one approver wins, and never after it expired.
  const now = new Date();
  const claimed = await prisma.adminApproval.updateMany({
    where: { id, status: ApprovalStatus.PENDING, expiresAt: { gt: now } },
    data: {
      status: ApprovalStatus.APPROVED,
      decidedById: admin.userId,
      decidedAt: now,
      decisionNote: note?.trim() || null,
    },
  });
  if (claimed.count === 0) {
    throw new ApiError(StatusCodes.CONFLICT, "This request is no longer pending");
  }

  await audit(ctx, {
    action: "approval.approve",
    entityType: "approval",
    entityId: id,
    after: { action: approval.action, summary: approval.summary },
    reason: note?.trim() || null,
  });

  const payload = approval.payload as Record<string, unknown>;
  const run = { approvalId: id, requestedById: approval.requestedById, ctx };

  try {
    const result = def.transactional
      ? await prisma.$transaction(async (tx) => {
          const out = await def.execute(payload, run, tx);
          await tx.adminApproval.update({
            where: { id },
            data: { status: ApprovalStatus.EXECUTED, executedAt: new Date(), result: toJson(out) },
          });
          return out;
        })
      : await def.execute(payload, run).then(async (out) => {
          await prisma.adminApproval.update({
            where: { id },
            data: { status: ApprovalStatus.EXECUTED, executedAt: new Date(), result: toJson(out) },
          });
          return out;
        });

    return { id, status: ApprovalStatus.EXECUTED, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.adminApproval.update({
      where: { id },
      data: { status: ApprovalStatus.FAILED, error: message.slice(0, 1000) },
    });
    throw new ApiError(
      error instanceof ApiError ? error.statusCode : StatusCodes.INTERNAL_SERVER_ERROR,
      `Approved, but the action failed: ${message}`,
    );
  }
};

const reject = async (
  admin: AdminContext,
  ctx: AuditCtx | undefined,
  id: string,
  note: string,
) => {
  // The requester may withdraw their own request; anyone else needs the
  // action's permission.
  const approval = await prisma.adminApproval.findUnique({ where: { id } });
  if (!approval) throw new ApiError(StatusCodes.NOT_FOUND, "Approval not found");
  if (approval.requestedById !== admin.userId) await loadForDecision(admin, id);

  const claimed = await prisma.adminApproval.updateMany({
    where: { id, status: ApprovalStatus.PENDING },
    data: {
      status: ApprovalStatus.REJECTED,
      decidedById: admin.userId,
      decidedAt: new Date(),
      decisionNote: note.trim(),
    },
  });
  if (claimed.count === 0) {
    throw new ApiError(StatusCodes.CONFLICT, "This request is no longer pending");
  }

  await audit(ctx, {
    action: "approval.reject",
    entityType: "approval",
    entityId: id,
    after: { action: approval.action, summary: approval.summary },
    reason: note.trim(),
  });

  return { id, status: ApprovalStatus.REJECTED };
};

/** Job approvals.expire: PENDING past its 24 h → EXPIRED. */
const expireStale = async () => {
  const { count } = await prisma.adminApproval.updateMany({
    where: { status: ApprovalStatus.PENDING, expiresAt: { lte: new Date() } },
    data: { status: ApprovalStatus.EXPIRED },
  });
  if (count) console.log(`[jobs] approvals.expire: expired ${count} request(s)`);
  return { expired: count };
};

export const AdminApprovalsService = { list, approve, reject, expireStale };
