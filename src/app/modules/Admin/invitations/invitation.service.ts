import { createHash, randomBytes } from "crypto";
import { StatusCodes } from "http-status-codes";
import type { AdminRole } from "@prisma/client";
import config from "../../../../config";
import ApiError from "../../../Error/error";
import prisma from "../../../shared/prisma";
import { audit, auditTx, AuditCtx } from "../../../utils/audit";
import { sendEmail } from "../../../utils/emailSender";
import { getAdminInvitationTemplate } from "../../../utils/emailTemplates";
import { normalizeEmail } from "../../../utils/normalizeEmail";
import { maskEmail } from "../admin.service";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const roleLabel = (kind: string, adminRole: AdminRole | null, area: string | null) =>
  kind === "ADMIN"
    ? `an admin (${(adminRole ?? "ANALYST").replace(/_/g, " ").toLowerCase()})`
    : `an area agent${area ? ` for ${area}` : ""}`;

type InviteInput = {
  email: string;
  name?: string;
  adminRole?: AdminRole;
  division?: string;
  district?: string;
  area?: string;
};

/**
 * One live invitation per address: older PENDING ones are revoked. Only the
 * sha256 of the token is stored; the emailed link is the only copy. When the
 * email cannot be sent the link is returned to the inviter instead.
 */
const createInvitation = async (
  kind: "ADMIN" | "AGENT",
  input: InviteInput,
  inviterId: string,
  ctx?: AuditCtx,
) => {
  const email = normalizeEmail(input.email);

  const existing = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" }, isDeleted: false },
    select: { role: true },
  });
  if (existing && (existing.role === "ADMIN" || existing.role === "AGENT")) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      `This email already belongs to ${existing.role === "ADMIN" ? "an admin" : "an agent"}.`,
    );
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const invitation = await prisma.$transaction(async (tx) => {
    await tx.adminInvitation.updateMany({
      where: { email, status: "PENDING" },
      data: { status: "REVOKED" },
    });
    return tx.adminInvitation.create({
      data: {
        email,
        kind,
        name: input.name?.trim() || null,
        adminRole: kind === "ADMIN" ? (input.adminRole ?? "ANALYST") : null,
        division: kind === "AGENT" ? input.division!.trim() : null,
        district: kind === "AGENT" ? input.district!.trim() : null,
        area: kind === "AGENT" ? input.area!.trim() : null,
        tokenHash: hashToken(token),
        invitedById: inviterId,
        expiresAt,
      },
    });
  });

  const inviter = await prisma.user.findUnique({
    where: { id: inviterId },
    select: { name: true },
  });
  const link = `${config.frontend_url}/invite/admin?token=${encodeURIComponent(token)}`;
  const sent = await sendEmail(
    email,
    "You are invited to the SalonKhuji team",
    getAdminInvitationTemplate({
      name: invitation.name,
      inviterName: inviter?.name ?? "A SalonKhuji admin",
      roleLabel: roleLabel(kind, invitation.adminRole, invitation.area),
      link,
      expiresAt,
    }),
  );

  await audit(ctx, {
    action: kind === "ADMIN" ? "admin.invite" : "agent.invite",
    entityType: "invitation",
    entityId: invitation.id,
    after: {
      email,
      kind,
      adminRole: invitation.adminRole,
      area: invitation.area,
      emailSent: sent.ok,
    },
  });

  return {
    id: invitation.id,
    email,
    kind,
    expiresAt,
    emailSent: sent.ok,
    // Only when the email failed: the inviter passes the link on themselves.
    ...(sent.ok ? {} : { inviteUrl: link }),
  };
};

const findByToken = async (token: string) => {
  const invitation = await prisma.adminInvitation.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!invitation) {
    throw ApiError.withCode(
      StatusCodes.NOT_FOUND,
      "This invitation link is not valid.",
      "INVITATION_NOT_FOUND",
    );
  }
  const status =
    invitation.status === "PENDING" && invitation.expiresAt <= new Date()
      ? ("EXPIRED" as const)
      : invitation.status;
  return { invitation, status };
};

/**
 * What the invite page shows. Public; the address stays masked. When the
 * caller is signed in, `forYou` says whether this invitation is theirs.
 */
const preview = async (token: string, callerId?: string) => {
  const { invitation, status } = await findByToken(token);

  const [inviter, caller] = await Promise.all([
    prisma.user.findUnique({ where: { id: invitation.invitedById }, select: { name: true } }),
    callerId
      ? prisma.user.findUnique({
          where: { id: callerId },
          select: { email: true, emailVerified: true },
        })
      : null,
  ]);

  return {
    status,
    kind: invitation.kind,
    adminRole: invitation.adminRole,
    area: invitation.area,
    district: invitation.district,
    division: invitation.division,
    inviterName: inviter?.name ?? null,
    maskedEmail: maskEmail(invitation.email),
    expiresAt: invitation.expiresAt,
    forYou: caller ? normalizeEmail(caller.email) === invitation.email : null,
    callerEmailVerified: caller ? caller.emailVerified : null,
  };
};

/**
 * Claims the invitation once (conditional update, count 0 → 409), makes the
 * caller an ADMIN or AGENT, and bumps sessionVersion so they sign in again
 * and meet the 2FA enrolment screen.
 */
const accept = async (token: string, callerId: string, ctx: AuditCtx) => {
  const { invitation, status } = await findByToken(token);
  if (status !== "PENDING") {
    throw ApiError.withCode(
      StatusCodes.CONFLICT,
      status === "ACCEPTED"
        ? "This invitation was already accepted."
        : "This invitation has expired or was withdrawn. Ask for a new one.",
      "INVITATION_UNAVAILABLE",
    );
  }

  const user = await prisma.user.findFirst({
    where: { id: callerId, isDeleted: false },
    select: { id: true, email: true, emailVerified: true, role: true },
  });
  if (!user || normalizeEmail(user.email) !== invitation.email) {
    throw ApiError.withCode(
      StatusCodes.FORBIDDEN,
      "This invitation was sent to a different email address.",
      "INVITATION_EMAIL_MISMATCH",
    );
  }
  if (!user.emailVerified) {
    throw ApiError.withCode(
      StatusCodes.FORBIDDEN,
      "Verify your email address before accepting.",
      "EMAIL_NOT_VERIFIED",
    );
  }
  if (user.role !== "CUSTOMER") {
    // Owners and staff keep salon access tied to their role; an admin or
    // agent account must be a separate one.
    throw ApiError.withCode(
      StatusCodes.CONFLICT,
      "This account already has a salon or admin role. Use a separate account for this invitation.",
      "INVITATION_ROLE_CONFLICT",
    );
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.adminInvitation.updateMany({
      where: { id: invitation.id, status: "PENDING", expiresAt: { gt: now } },
      data: { status: "ACCEPTED", acceptedAt: now, acceptedByUserId: user.id },
    });
    if (claimed.count === 0) {
      throw ApiError.withCode(
        StatusCodes.CONFLICT,
        "This invitation is no longer available.",
        "INVITATION_UNAVAILABLE",
      );
    }

    if (invitation.kind === "ADMIN") {
      const adminRole = invitation.adminRole ?? "ANALYST";
      await tx.admin.upsert({
        where: { userId: user.id },
        create: { userId: user.id, adminRole, invitedById: invitation.invitedById },
        update: { adminRole, invitedById: invitation.invitedById },
      });
    } else {
      const area = {
        division: invitation.division ?? "",
        district: invitation.district ?? "",
        area: invitation.area ?? "",
      };
      await tx.agent.upsert({
        where: { userId: user.id },
        create: { userId: user.id, ...area },
        update: area,
      });
    }

    await tx.user.update({
      where: { id: user.id },
      data: { role: invitation.kind as "ADMIN" | "AGENT", sessionVersion: { increment: 1 } },
    });

    await auditTx(tx, { ...ctx, actorUserId: user.id, actorRole: user.role }, {
      action: invitation.kind === "ADMIN" ? "admin.accept" : "agent.accept",
      entityType: "user",
      entityId: user.id,
      before: { role: user.role },
      after: {
        role: invitation.kind,
        adminRole: invitation.adminRole,
        area: invitation.area,
        invitationId: invitation.id,
      },
    });
  });

  return { kind: invitation.kind, adminRole: invitation.adminRole, area: invitation.area };
};

/** Pending invitations of one kind, newest first; `expired` ones can be resent. */
const listPending = async (kind: "ADMIN" | "AGENT") => {
  const rows = await prisma.adminInvitation.findMany({
    where: { kind, status: "PENDING" },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      email: true,
      name: true,
      adminRole: true,
      division: true,
      district: true,
      area: true,
      expiresAt: true,
      createdAt: true,
      invitedById: true,
    },
  });
  const inviterIds = [...new Set(rows.map((r) => r.invitedById))];
  const inviters = inviterIds.length
    ? await prisma.user.findMany({ where: { id: { in: inviterIds } }, select: { id: true, name: true } })
    : [];
  const names = new Map(inviters.map((u) => [u.id, u.name]));
  const now = new Date();
  return rows.map(({ invitedById, ...r }) => ({
    ...r,
    invitedBy: names.get(invitedById) ?? null,
    expired: r.expiresAt <= now,
  }));
};

const findPending = async (id: string, kind: "ADMIN" | "AGENT") => {
  const invitation = await prisma.adminInvitation.findUnique({ where: { id } });
  if (!invitation || invitation.kind !== kind || invitation.status !== "PENDING") {
    throw new ApiError(StatusCodes.NOT_FOUND, "No pending invitation found");
  }
  return invitation;
};

/** A fresh link (new token, new expiry); the old one stops working. */
const resendInvitation = async (
  id: string,
  kind: "ADMIN" | "AGENT",
  inviterId: string,
  ctx?: AuditCtx,
) => {
  const invitation = await findPending(id, kind);
  return createInvitation(
    kind,
    {
      email: invitation.email,
      name: invitation.name ?? undefined,
      adminRole: invitation.adminRole ?? undefined,
      division: invitation.division ?? undefined,
      district: invitation.district ?? undefined,
      area: invitation.area ?? undefined,
    },
    inviterId,
    ctx,
  );
};

const revokeInvitation = async (id: string, kind: "ADMIN" | "AGENT", ctx?: AuditCtx) => {
  const invitation = await findPending(id, kind);
  const { count } = await prisma.adminInvitation.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "REVOKED" },
  });
  if (!count) throw new ApiError(StatusCodes.NOT_FOUND, "No pending invitation found");
  await audit(ctx, {
    action: kind === "ADMIN" ? "admin.invite_revoke" : "agent.invite_revoke",
    entityType: "invitation",
    entityId: id,
    before: { status: "PENDING" },
    after: { status: "REVOKED", email: invitation.email },
  });
  return { id };
};

export const InvitationService = {
  createInvitation,
  preview,
  accept,
  listPending,
  resendInvitation,
  revokeInvitation,
};
