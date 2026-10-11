import { Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../../Error/error";
import prisma from "../../../shared/prisma";
import { audit, AuditCtx } from "../../../utils/audit";
import type { AdminContext } from "../admin.middleware";
import { normalizeArea } from "../admin.permissions";
import { parseListQuery } from "../admin.query";
import { maskEmail, maskPhone } from "../admin.service";
import { InvitationService } from "../invitations/invitation.service";
import { AdminUsersService } from "../users/users.service";

const listAgents = async (admin: AdminContext, query: Record<string, unknown>) => {
  const { skip, take, q, page, limit } = parseListQuery(query, {
    sortable: ["createdAt"],
    defaultSort: { field: "createdAt", order: "desc" },
  });
  const where: Prisma.AgentWhereInput = {
    user: { isDeleted: false, role: "AGENT" },
    ...(q
      ? {
          OR: [
            { user: { name: { contains: q, mode: "insensitive" } } },
            { user: { email: { contains: q, mode: "insensitive" } } },
            { area: { contains: q, mode: "insensitive" } },
            { district: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const pii = admin.permissions.includes("users.view_pii");

  const [rows, total, invitations] = await Promise.all([
    prisma.agent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      select: {
        division: true,
        district: true,
        area: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            profilePhoto: true,
            status: true,
            statusReason: true,
            lastActiveAt: true,
            mfa: { select: { enabledAt: true } },
          },
        },
      },
    }),
    prisma.agent.count({ where }),
    page === 1 ? InvitationService.listPending("AGENT") : Promise.resolve([]),
  ]);

  return {
    meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    data: {
      agents: rows.map(({ user, ...a }) => ({
        ...a,
        id: user.id,
        name: user.name,
        email: pii ? user.email : maskEmail(user.email),
        phone: pii ? user.phone : maskPhone(user.phone),
        profilePhoto: user.profilePhoto,
        status: user.status,
        statusReason: user.statusReason,
        lastActiveAt: user.lastActiveAt,
        mfaEnabled: !!user.mfa?.enabledAt,
      })),
      invitations,
    },
  };
};

const loadAgent = async (userId: string) => {
  const agent = await prisma.agent.findUnique({
    where: { userId },
    select: {
      division: true,
      district: true,
      area: true,
      user: { select: { id: true, name: true, email: true, role: true, status: true, isDeleted: true } },
    },
  });
  if (!agent || agent.user.isDeleted || agent.user.role !== "AGENT") {
    throw new ApiError(StatusCodes.NOT_FOUND, "Agent not found");
  }
  return agent;
};

type Place = { division: string; district: string; area: string };

/** Re-scopes the agent; takes effect on their next request (area is read per request). */
const updateArea = async (ctx: AuditCtx | undefined, userId: string, input: Place & { reason: string }) => {
  const agent = await loadAgent(userId);
  const next = { division: input.division, district: input.district, area: input.area };
  await prisma.agent.update({ where: { userId }, data: next });
  await audit(ctx, {
    action: "agent.update_area",
    entityType: "user",
    entityId: userId,
    before: { division: agent.division, district: agent.district, area: agent.area },
    after: next,
    reason: input.reason,
  });
  return { id: userId, ...next };
};

const updateStatus = async (
  ctx: AuditCtx | undefined,
  userId: string,
  input: { status: "ACTIVE" | "SUSPENDED" | "BLOCKED"; reason: string },
) => {
  const agent = await loadAgent(userId);
  if (agent.user.status === input.status) {
    throw new ApiError(StatusCodes.CONFLICT, `This agent is already ${input.status.toLowerCase()}`);
  }
  const restricting = input.status !== "ACTIVE";
  await prisma.user.update({
    where: { id: userId },
    data: {
      status: input.status,
      statusReason: input.reason,
      statusChangedAt: new Date(),
      suspendedUntil: null,
      ...(restricting ? { sessionVersion: { increment: 1 } } : {}),
    },
  });
  await audit(ctx, {
    action:
      input.status === "ACTIVE" ? "agent.reactivate" : input.status === "SUSPENDED" ? "agent.suspend" : "agent.block",
    entityType: "user",
    entityId: userId,
    before: { status: agent.user.status },
    after: { status: input.status },
    reason: input.reason,
  });
  AdminUsersService.notifyAccountStatus(agent.user, input.status, input.reason, null);
  return { id: userId, status: input.status };
};

/**
 * Every place that has a salon, so an agent's area is picked, not typed.
 * Spellings that differ only in case or spaces collapse into the most used one.
 */
const listAreas = async () => {
  const groups = await prisma.salon.groupBy({
    by: ["division", "district", "area"],
    where: { isDeleted: false, NOT: { area: "N/A" } },
    _count: { _all: true },
  });

  const merged = new Map<string, Place & { salons: number; top: number }>();
  for (const g of groups) {
    const key = [g.division, g.district, g.area].map(normalizeArea).join("|");
    const n = g._count._all;
    const hit = merged.get(key);
    if (!hit) {
      merged.set(key, { division: g.division.trim(), district: g.district.trim(), area: g.area.trim(), salons: n, top: n });
    } else {
      hit.salons += n;
      if (n > hit.top) Object.assign(hit, { division: g.division.trim(), district: g.district.trim(), area: g.area.trim(), top: n });
    }
  }

  return [...merged.values()]
    .map(({ top: _top, ...p }) => p)
    .sort((a, b) =>
      a.division.localeCompare(b.division) || a.district.localeCompare(b.district) || a.area.localeCompare(b.area),
    );
};

export const AdminAgentsService = {
  listAgents,
  updateArea,
  updateStatus,
  listAreas,
};
