import { AdminRole, Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../../Error/error";
import prisma from "../../../shared/prisma";
import { auditTx, AuditCtx } from "../../../utils/audit";
import { sendEmail } from "../../../utils/emailSender";
import { getAdminTeamChangeTemplate } from "../../../utils/emailTemplates";
import type { AdminContext } from "../admin.middleware";
import { InvitationService } from "../invitations/invitation.service";

const roleName = (role: AdminRole) => role.replace(/_/g, " ").toLowerCase();

// Serializable, so two super admins demoting each other at the same moment
// cannot both pass the "someone else is left" check.
const SERIALIZABLE = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable };

const listTeam = async () => {
  const [members, invitations] = await Promise.all([
    prisma.user.findMany({
      where: { role: "ADMIN", isDeleted: false },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        email: true,
        profilePhoto: true,
        status: true,
        lastActiveAt: true,
        createdAt: true,
        admin: { select: { adminRole: true } },
        mfa: { select: { enabledAt: true } },
      },
    }),
    InvitationService.listPending("ADMIN"),
  ]);

  return {
    members: members.map(({ admin, mfa, ...m }) => ({
      ...m,
      adminRole: admin?.adminRole ?? null,
      mfaEnabled: !!mfa?.enabledAt,
    })),
    invitations,
  };
};

const loadMember = async (userId: string) => {
  const member = await prisma.user.findFirst({
    where: { id: userId, role: "ADMIN", isDeleted: false },
    select: { id: true, name: true, email: true, admin: { select: { adminRole: true } } },
  });
  if (!member?.admin) throw new ApiError(StatusCodes.NOT_FOUND, "Team member not found");
  return { ...member, adminRole: member.admin.adminRole };
};

const assertNotSelf = (actor: AdminContext, userId: string, what: string) => {
  if (actor.userId === userId) throw new ApiError(StatusCodes.CONFLICT, `You cannot ${what} yourself`);
};

/** Refuses when `userId` is a SUPER_ADMIN and no other active one is left. */
const assertAnotherSuperAdmin = async (
  tx: Prisma.TransactionClient,
  userId: string,
  currentRole: AdminRole,
) => {
  if (currentRole !== "SUPER_ADMIN") return;
  const others = await tx.admin.count({
    where: {
      adminRole: "SUPER_ADMIN",
      userId: { not: userId },
      user: { role: "ADMIN", status: "ACTIVE", isDeleted: false },
    },
  });
  if (others === 0) {
    throw new ApiError(StatusCodes.CONFLICT, "The last super admin can't be demoted or removed");
  }
};

/** The affected admin and every super admin hear about a team change. */
const notifyTeam = async (
  member: { email: string },
  actor: AdminContext,
  heading: string,
  summary: string,
  reason?: string,
) => {
  try {
    const [supers, actorUser] = await Promise.all([
      prisma.user.findMany({
        where: { role: "ADMIN", status: "ACTIVE", isDeleted: false, admin: { adminRole: "SUPER_ADMIN" } },
        select: { email: true },
      }),
      prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } }),
    ]);
    const html = getAdminTeamChangeTemplate({
      heading,
      summary,
      actorName: actorUser?.name ?? "A super admin",
      reason,
    });
    const recipients = new Set([member.email, ...supers.map((s) => s.email)]);
    await Promise.all([...recipients].map((to) => sendEmail(to, heading, html)));
  } catch (error) {
    console.error("[admin] team change email failed", error);
  }
};

const changeRole = async (
  actor: AdminContext,
  ctx: AuditCtx | undefined,
  userId: string,
  adminRole: AdminRole,
  reason: string,
) => {
  assertNotSelf(actor, userId, "change the admin role of");
  const member = await loadMember(userId);
  if (member.adminRole === adminRole) throw new ApiError(StatusCodes.CONFLICT, "They already have this role");

  await prisma.$transaction(async (tx) => {
    if (adminRole !== "SUPER_ADMIN") await assertAnotherSuperAdmin(tx, userId, member.adminRole);
    await tx.admin.update({ where: { userId }, data: { adminRole } });
    await auditTx(tx, ctx, {
      action: "admin.role_change",
      entityType: "user",
      entityId: userId,
      before: { adminRole: member.adminRole },
      after: { adminRole },
      reason,
    });
  }, SERIALIZABLE);

  void notifyTeam(
    member,
    actor,
    "Admin role changed",
    `${member.name}'s admin role changed from ${roleName(member.adminRole)} to ${roleName(adminRole)}.`,
    reason,
  );
  return { userId, adminRole };
};

/** Back to a plain customer account; every session ends. */
const removeMember = async (actor: AdminContext, ctx: AuditCtx | undefined, userId: string, reason: string) => {
  assertNotSelf(actor, userId, "remove");
  const member = await loadMember(userId);

  await prisma.$transaction(async (tx) => {
    await assertAnotherSuperAdmin(tx, userId, member.adminRole);
    await tx.admin.delete({ where: { userId } });
    await tx.user.update({
      where: { id: userId },
      data: { role: "CUSTOMER", sessionVersion: { increment: 1 } },
    });
    await auditTx(tx, ctx, {
      action: "admin.remove",
      entityType: "user",
      entityId: userId,
      before: { role: "ADMIN", adminRole: member.adminRole },
      after: { role: "CUSTOMER" },
      reason,
    });
  }, SERIALIZABLE);

  void notifyTeam(
    member,
    actor,
    "Removed from the admin team",
    `${member.name} (${roleName(member.adminRole)}) was removed from the SalonKhuji admin team. The account is now a customer account.`,
    reason,
  );
  return { userId };
};

/** They enrol again on the next sign-in; every session ends. */
const resetMfa = async (actor: AdminContext, ctx: AuditCtx | undefined, userId: string, reason: string) => {
  assertNotSelf(actor, userId, "reset two-factor sign-in for");
  const member = await loadMember(userId);

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.userMfa.deleteMany({ where: { userId } });
    if (!count) throw new ApiError(StatusCodes.CONFLICT, "Two-factor sign-in is not set up for this account");
    await tx.user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
    await auditTx(tx, ctx, {
      action: "admin.mfa_reset",
      entityType: "user",
      entityId: userId,
      reason,
    });
  });

  void notifyTeam(
    member,
    actor,
    "Two-factor sign-in reset",
    `Two-factor sign-in was reset for ${member.name}. They will set up an authenticator app again at their next sign-in.`,
    reason,
  );
  return { userId };
};

export const AdminTeamService = {
  listTeam,
  changeRole,
  removeMember,
  resetMfa,
};
