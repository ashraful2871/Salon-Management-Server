import { createHash, randomBytes } from "crypto";
import { StatusCodes } from "http-status-codes";
import { BranchRole, MemberStatus, Prisma, UserRole } from "@prisma/client";
import config from "../../../config";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { audit, auditTx, AuditCtx } from "../../utils/audit";
import { sendEmail } from "../../utils/emailSender";
import { getTeamInvitationTemplate, getTeamJoinedTemplate } from "../../utils/emailTemplates";
import { normalizeEmail } from "../../utils/normalizeEmail";
import { AccessUser, assertSalonPermission, grantAt } from "../../utils/salonAccess";
import { maskEmail } from "../Admin/admin.service";

type Db = Prisma.TransactionClient | typeof prisma;

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const notFound = (what = "Not found") => new ApiError(StatusCodes.NOT_FOUND, what);

/** Today's date in Dhaka as the date-only value appointments store. */
const dhakaToday = () =>
  new Date(`${new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" })}T00:00:00.000Z`);

// ---------------------------------------------------------------------------
// Account role
// ---------------------------------------------------------------------------

/**
 * The account type a user's memberships add up to: owns a business →
 * SALON_OWNER; any ACTIVE MANAGER/RECEPTIONIST seat → BRANCH_MANAGER; only
 * STYLIST seats → STAFF; none → CUSTOMER. Admins and agents are never touched.
 */
export const deriveAccountRole = async (db: Db, userId: string): Promise<UserRole> => {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      role: true,
      salonOwner: { select: { id: true } },
      staff: { select: { isDeleted: true, salonId: true } },
      salonMemberships: {
        where: { status: MemberStatus.ACTIVE, salon: { isDeleted: false } },
        select: { role: true, salonId: true },
      },
    },
  });
  if (!user) throw notFound("User not found");
  if (user.role === UserRole.ADMIN || user.role === UserRole.AGENT) return user.role;
  if (user.salonOwner) return UserRole.SALON_OWNER;
  const roles = user.salonMemberships.map((m) => m.role);
  if (roles.some((r) => r === BranchRole.MANAGER || r === BranchRole.RECEPTIONIST)) {
    return UserRole.BRANCH_MANAGER;
  }
  if (roles.length) return UserRole.STAFF;
  return UserRole.CUSTOMER;
};

/**
 * Writes the derived role and bumps sessionVersion, so the next request signs
 * the user in again with a token that carries the new role (the frontend
 * reads the role from the token).
 */
export const syncAccountRole = async (db: Db, userId: string) => {
  const role = await deriveAccountRole(db, userId);
  await db.user.update({
    where: { id: userId },
    data: { role, sessionVersion: { increment: 1 } },
  });
  return role;
};

// ---------------------------------------------------------------------------
// Stylist profile (the Staff row bookings are assigned to)
// ---------------------------------------------------------------------------

/** A STYLIST seat needs a live Staff row at that salon; a user has at most one. */
const ensureStylistProfile = async (tx: Prisma.TransactionClient, userId: string, salonId: string) => {
  const staff = await tx.staff.findUnique({ where: { userId }, select: { id: true, salonId: true, isDeleted: true } });
  if (!staff) {
    await tx.staff.create({ data: { userId, salonId } });
    return;
  }
  if (!staff.isDeleted && staff.salonId !== salonId) {
    throw ApiError.withCode(
      StatusCodes.CONFLICT,
      "This person already works as a stylist at another salon.",
      "STYLIST_ELSEWHERE",
    );
  }
  if (staff.isDeleted || staff.salonId !== salonId) {
    await tx.staff.update({ where: { id: staff.id }, data: { salonId, isDeleted: false } });
  }
};

/** Takes the stylist off the booking list at `salonId`; their bookings keep the assignment. */
const retireStylistProfile = async (tx: Prisma.TransactionClient, userId: string, salonId: string) => {
  await tx.staff.updateMany({ where: { userId, salonId, isDeleted: false }, data: { isDeleted: true } });
};

/** PENDING/CONFIRMED bookings from today on assigned to this user's stylist profile at the salon. */
const futureBookingsOf = async (userId: string, salonId: string) => {
  const staff = await prisma.staff.findUnique({ where: { userId }, select: { id: true, salonId: true } });
  if (!staff || staff.salonId !== salonId) return 0;
  return prisma.appointment.count({
    where: {
      salonId,
      staffId: staff.id,
      status: { in: ["PENDING", "CONFIRMED"] },
      appointmentDate: { gte: dhakaToday() },
    },
  });
};

// ---------------------------------------------------------------------------
// Who may manage whom
// ---------------------------------------------------------------------------

type ActorSeat = "OWNER" | "MANAGER";

/**
 * The actor's standing at the branch for team work: OWNER (the owner or an
 * admin) or MANAGER. Anyone else - including a member of another branch - 404.
 */
const actorSeat = async (actor: AccessUser, salonId: string): Promise<ActorSeat> => {
  await assertSalonPermission(actor, salonId, "team.invite");
  if (actor.role === UserRole.ADMIN) return "OWNER";
  const grant = await grantAt(actor, salonId);
  return grant?.role === "OWNER" ? "OWNER" : "MANAGER";
};

/** A manager handles receptionists and stylists only; the owner handles everyone. */
const assertCanHandle = (seat: ActorSeat, role: BranchRole) => {
  if (seat === "MANAGER" && role === BranchRole.MANAGER) {
    throw new ApiError(StatusCodes.FORBIDDEN, "Only the owner can invite or change a manager.");
  }
};

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

const listMembers = async (actor: AccessUser, salonId: string, query: { includeRemoved?: unknown }) => {
  await actorSeat(actor, salonId);
  const rows = await prisma.salonMember.findMany({
    where: {
      salonId,
      ...(query.includeRemoved === "true" ? {} : { status: { not: MemberStatus.REMOVED } }),
    },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      role: true,
      status: true,
      notifyNewBookings: true,
      createdAt: true,
      removedAt: true,
      user: { select: { id: true, name: true, email: true, phone: true, profilePhoto: true } },
    },
  });
  return rows.map(({ createdAt, user, ...row }) => ({
    ...row,
    userId: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    profilePhoto: user.profilePhoto,
    joinedAt: createdAt,
  }));
};

const loadMember = async (salonId: string, memberId: string) => {
  const member = await prisma.salonMember.findFirst({
    where: { id: memberId, salonId },
    select: { id: true, userId: true, role: true, status: true },
  });
  if (!member) throw notFound("Member not found");
  return member;
};

const updateMember = async (
  actor: AccessUser,
  salonId: string,
  memberId: string,
  payload: { role?: BranchRole; status?: "ACTIVE" | "SUSPENDED" },
  ctx: AuditCtx,
) => {
  const seat = await actorSeat(actor, salonId);
  const member = await loadMember(salonId, memberId);
  if (member.userId === actor.userId) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "You can't change your own seat.");
  }
  if (member.status === MemberStatus.REMOVED) {
    throw new ApiError(StatusCodes.CONFLICT, "This person was removed. Invite them again instead.");
  }
  assertCanHandle(seat, member.role);
  const role = payload.role ?? member.role;
  const status = payload.status ?? member.status;
  assertCanHandle(seat, role);

  const changed = await prisma.$transaction(async (tx) => {
    if (role === BranchRole.STYLIST && status === MemberStatus.ACTIVE) {
      await ensureStylistProfile(tx, member.userId, salonId);
    } else if (member.role === BranchRole.STYLIST) {
      await retireStylistProfile(tx, member.userId, salonId);
    }
    const updated = await tx.salonMember.update({
      where: { id: member.id },
      data: { role, status },
      select: { id: true, role: true, status: true },
    });
    const accountRole = await syncAccountRole(tx, member.userId);
    await auditTx(tx, ctx, {
      action: "team.member_update",
      entityType: "salon_member",
      entityId: member.id,
      salonId,
      before: { role: member.role, status: member.status },
      after: { role, status, accountRole },
    });
    return updated;
  });

  const futureBookings =
    member.role === BranchRole.STYLIST && (role !== BranchRole.STYLIST || status !== MemberStatus.ACTIVE)
      ? await futureBookingsOf(member.userId, salonId)
      : 0;
  return { ...changed, futureBookings };
};

/** Soft remove: the row stays REMOVED. A stylist's future bookings are reported, not cancelled. */
const finishRemoval = async (
  member: { id: string; userId: string; role: BranchRole; status: MemberStatus },
  salonId: string,
  removedById: string,
  action: "team.member_remove" | "team.member_leave",
  ctx: AuditCtx,
) => {
  await prisma.$transaction(async (tx) => {
    await tx.salonMember.update({
      where: { id: member.id },
      data: { status: MemberStatus.REMOVED, removedAt: new Date(), removedById },
    });
    if (member.role === BranchRole.STYLIST) await retireStylistProfile(tx, member.userId, salonId);
    const accountRole = await syncAccountRole(tx, member.userId);
    await auditTx(tx, ctx, {
      action,
      entityType: "salon_member",
      entityId: member.id,
      salonId,
      before: { role: member.role, status: member.status },
      after: { status: MemberStatus.REMOVED, accountRole },
    });
  });
  const futureBookings =
    member.role === BranchRole.STYLIST ? await futureBookingsOf(member.userId, salonId) : 0;
  return { id: member.id, status: MemberStatus.REMOVED, futureBookings };
};

const removeMember = async (actor: AccessUser, salonId: string, memberId: string, ctx: AuditCtx) => {
  const seat = await actorSeat(actor, salonId);
  const member = await loadMember(salonId, memberId);
  if (member.userId === actor.userId) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "To leave this branch, use Leave instead.");
  }
  if (member.status === MemberStatus.REMOVED) {
    throw new ApiError(StatusCodes.CONFLICT, "This person was already removed.");
  }
  assertCanHandle(seat, member.role);
  return finishRemoval(member, salonId, actor.userId, "team.member_remove", ctx);
};

const leave = async (actor: AccessUser, salonId: string, ctx: AuditCtx) => {
  const member = await prisma.salonMember.findUnique({
    where: { salonId_userId: { salonId, userId: actor.userId } },
    select: { id: true, userId: true, role: true, status: true },
  });
  if (!member || member.status === MemberStatus.REMOVED) throw notFound();
  return finishRemoval(member, salonId, actor.userId, "team.member_leave", ctx);
};

/**
 * Staff removal from the older Staff screen: the same as removing the
 * stylist's seat, or (no seat yet) retiring the profile and re-deriving the role.
 */
export const removeStylistByStaff = async (
  staff: { userId: string; salonId: string },
  removedById: string,
  ctx: AuditCtx,
) => {
  const member = await prisma.salonMember.findUnique({
    where: { salonId_userId: { salonId: staff.salonId, userId: staff.userId } },
    select: { id: true, userId: true, role: true, status: true },
  });
  if (member && member.status !== MemberStatus.REMOVED) {
    return finishRemoval(
      { ...member, role: BranchRole.STYLIST },
      staff.salonId,
      removedById,
      "team.member_remove",
      ctx,
    );
  }
  await prisma.$transaction(async (tx) => {
    await retireStylistProfile(tx, staff.userId, staff.salonId);
    await syncAccountRole(tx, staff.userId);
  });
  return null;
};

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

type InviteInput = { email: string; role: BranchRole; name?: string };

const sendInvitationEmail = async (
  invitation: { email: string; name: string | null; role: BranchRole; salonId: string; invitedById: string },
  token: string,
  expiresAt: Date,
) => {
  const [salon, inviter] = await Promise.all([
    prisma.salon.findUnique({ where: { id: invitation.salonId }, select: { name: true } }),
    prisma.user.findUnique({ where: { id: invitation.invitedById }, select: { name: true } }),
  ]);
  const link = `${config.frontend_url}/invite?token=${encodeURIComponent(token)}`;
  const sent = await sendEmail(
    invitation.email,
    `Join ${salon?.name ?? "a salon"} on SalonKhuji`,
    getTeamInvitationTemplate({
      name: invitation.name,
      inviterName: inviter?.name ?? "The salon owner",
      salonName: salon?.name ?? "a salon",
      role: invitation.role,
      link,
      expiresAt,
    }),
  );
  return { sent: sent.ok, link };
};

/**
 * One live invitation per (branch, address): older PENDING ones are revoked.
 * Refuses admin/agent addresses, the owner and anyone already ACTIVE here.
 */
const invite = async (actor: AccessUser, salonId: string, input: InviteInput, ctx: AuditCtx) => {
  const seat = await actorSeat(actor, salonId);
  assertCanHandle(seat, input.role);
  const email = normalizeEmail(input.email);

  const [salon, existing] = await Promise.all([
    prisma.salon.findFirst({
      where: { id: salonId, isDeleted: false },
      select: { id: true, owner: { select: { userId: true } } },
    }),
    prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" }, isDeleted: false },
      select: {
        id: true,
        role: true,
        staff: { select: { salonId: true, isDeleted: true } },
      },
    }),
  ]);
  if (!salon) throw notFound();

  if (existing) {
    if (existing.role === UserRole.ADMIN || existing.role === UserRole.AGENT) {
      throw new ApiError(StatusCodes.CONFLICT, "This email belongs to a SalonKhuji staff account.");
    }
    if (existing.id === salon.owner.userId) {
      throw new ApiError(StatusCodes.CONFLICT, "That's the owner of this salon.");
    }
    const seatHere = await prisma.salonMember.findUnique({
      where: { salonId_userId: { salonId, userId: existing.id } },
      select: { status: true },
    });
    if (seatHere?.status === MemberStatus.ACTIVE) {
      throw new ApiError(StatusCodes.CONFLICT, "This person already works at this branch.");
    }
    if (
      input.role === BranchRole.STYLIST &&
      existing.staff &&
      !existing.staff.isDeleted &&
      existing.staff.salonId !== salonId
    ) {
      throw new ApiError(StatusCodes.CONFLICT, "This person already works as a stylist at another salon.");
    }
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const invitation = await prisma.$transaction(async (tx) => {
    await tx.salonInvitation.updateMany({
      where: { salonId, email, status: "PENDING" },
      data: { status: "REVOKED" },
    });
    return tx.salonInvitation.create({
      data: {
        salonId,
        email,
        name: input.name?.trim() || null,
        role: input.role,
        tokenHash: hashToken(token),
        invitedById: actor.userId,
        expiresAt,
      },
    });
  });

  const { sent, link } = await sendInvitationEmail(invitation, token, expiresAt);

  await audit(ctx, {
    action: "team.invite",
    entityType: "salon_invitation",
    entityId: invitation.id,
    salonId,
    after: { email, role: input.role, emailSent: sent },
  });

  return {
    id: invitation.id,
    email,
    role: invitation.role,
    expiresAt,
    emailSent: sent,
    // Only when the email failed: the inviter passes the link on themselves.
    ...(sent ? {} : { inviteUrl: link }),
  };
};

const listInvitations = async (actor: AccessUser, salonId: string) => {
  const seat = await actorSeat(actor, salonId);
  const rows = await prisma.salonInvitation.findMany({
    where: { salonId, status: "PENDING", ...(seat === "MANAGER" ? { invitedById: actor.userId } : {}) },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, email: true, name: true, role: true, expiresAt: true, createdAt: true, invitedById: true },
  });
  const inviterIds = [...new Set(rows.map((r) => r.invitedById))];
  const inviters = await prisma.user.findMany({
    where: { id: { in: inviterIds } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(inviters.map((u) => [u.id, u.name]));
  const now = new Date();
  return rows.map((row) => ({
    ...row,
    inviterName: nameOf.get(row.invitedById) ?? null,
    expired: row.expiresAt <= now,
  }));
};

/** The invitation, when the actor invited it or owns the branch; 404 otherwise. */
const loadOwnInvitation = async (actor: AccessUser, invitationId: string) => {
  const invitation = await prisma.salonInvitation.findUnique({ where: { id: invitationId } });
  if (!invitation) throw notFound("Invitation not found");
  const seat = await actorSeat(actor, invitation.salonId).catch(() => {
    throw notFound("Invitation not found");
  });
  if (seat === "MANAGER" && invitation.invitedById !== actor.userId) throw notFound("Invitation not found");
  if (invitation.status !== "PENDING") {
    throw new ApiError(StatusCodes.CONFLICT, "This invitation was already accepted or withdrawn.");
  }
  return invitation;
};

/** A new token and a fresh 7 days; the old link stops working. */
const resend = async (actor: AccessUser, invitationId: string, ctx: AuditCtx) => {
  const invitation = await loadOwnInvitation(actor, invitationId);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const claimed = await prisma.salonInvitation.updateMany({
    where: { id: invitation.id, status: "PENDING" },
    data: { tokenHash: hashToken(token), expiresAt },
  });
  if (claimed.count === 0) {
    throw new ApiError(StatusCodes.CONFLICT, "This invitation was already accepted or withdrawn.");
  }
  const { sent, link } = await sendInvitationEmail(invitation, token, expiresAt);
  await audit(ctx, {
    action: "team.invite_resend",
    entityType: "salon_invitation",
    entityId: invitation.id,
    salonId: invitation.salonId,
    after: { email: invitation.email, role: invitation.role, emailSent: sent },
  });
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    expiresAt,
    emailSent: sent,
    ...(sent ? {} : { inviteUrl: link }),
  };
};

const revoke = async (actor: AccessUser, invitationId: string, ctx: AuditCtx) => {
  const invitation = await loadOwnInvitation(actor, invitationId);
  await prisma.salonInvitation.updateMany({
    where: { id: invitation.id, status: "PENDING" },
    data: { status: "REVOKED" },
  });
  await audit(ctx, {
    action: "team.invite_revoke",
    entityType: "salon_invitation",
    entityId: invitation.id,
    salonId: invitation.salonId,
    before: { email: invitation.email, role: invitation.role },
  });
  return null;
};

const findByToken = async (token: string) => {
  const invitation = await prisma.salonInvitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      salon: {
        select: {
          id: true,
          name: true,
          area: true,
          address: true,
          isDeleted: true,
          owner: { select: { userId: true, businessName: true } },
        },
      },
    },
  });
  if (!invitation) {
    throw ApiError.withCode(StatusCodes.NOT_FOUND, "This invitation link is not valid.", "INVITATION_NOT_FOUND");
  }
  const status =
    invitation.status === "PENDING" && (invitation.expiresAt <= new Date() || invitation.salon.isDeleted)
      ? ("EXPIRED" as const)
      : invitation.status;
  return { invitation, status };
};

/** What the invite page shows. Public; the address stays masked. */
const preview = async (token: string, callerId?: string) => {
  const { invitation, status } = await findByToken(token);
  const [inviter, caller] = await Promise.all([
    prisma.user.findUnique({ where: { id: invitation.invitedById }, select: { name: true } }),
    callerId
      ? prisma.user.findUnique({ where: { id: callerId }, select: { email: true, emailVerified: true } })
      : null,
  ]);
  return {
    status,
    role: invitation.role,
    salon: {
      id: invitation.salon.id,
      name: invitation.salon.name,
      area: invitation.salon.area,
      address: invitation.salon.address,
    },
    businessName: invitation.salon.owner.businessName,
    inviterName: inviter?.name ?? null,
    maskedEmail: maskEmail(invitation.email),
    expiresAt: invitation.expiresAt,
    forYou: caller ? normalizeEmail(caller.email) === invitation.email : null,
    callerEmailVerified: caller ? caller.emailVerified : null,
  };
};

/**
 * Claims the invitation once (conditional update, count 0 → 409), seats the
 * caller at the branch, gives a stylist a Staff profile, re-derives the
 * account role and bumps sessionVersion so they sign in again with it.
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
    select: { id: true, name: true, email: true, emailVerified: true, role: true },
  });
  if (!user || normalizeEmail(user.email) !== invitation.email) {
    throw ApiError.withCode(
      StatusCodes.FORBIDDEN,
      "This invitation was sent to a different email address.",
      "INVITATION_EMAIL_MISMATCH",
    );
  }
  if (!user.emailVerified) {
    throw ApiError.withCode(StatusCodes.FORBIDDEN, "Verify your email address before accepting.", "EMAIL_NOT_VERIFIED");
  }
  if (user.role === UserRole.ADMIN || user.role === UserRole.AGENT || user.id === invitation.salon.owner.userId) {
    throw ApiError.withCode(
      StatusCodes.CONFLICT,
      "This account can't join a salon team. Use a separate account for this invitation.",
      "INVITATION_ROLE_CONFLICT",
    );
  }

  const now = new Date();
  const accountRole = await prisma.$transaction(async (tx) => {
    const claimed = await tx.salonInvitation.updateMany({
      where: { id: invitation.id, status: "PENDING", expiresAt: { gt: now } },
      data: { status: "ACCEPTED", acceptedAt: now, acceptedByUserId: user.id },
    });
    if (claimed.count === 0) {
      throw ApiError.withCode(StatusCodes.CONFLICT, "This invitation is no longer available.", "INVITATION_UNAVAILABLE");
    }

    if (invitation.role === BranchRole.STYLIST) {
      await ensureStylistProfile(tx, user.id, invitation.salonId);
    }
    const seat = {
      role: invitation.role,
      status: MemberStatus.ACTIVE,
      invitedById: invitation.invitedById,
      removedAt: null,
      removedById: null,
    };
    await tx.salonMember.upsert({
      where: { salonId_userId: { salonId: invitation.salonId, userId: user.id } },
      create: { salonId: invitation.salonId, userId: user.id, ...seat },
      update: seat,
    });
    const role = await syncAccountRole(tx, user.id);

    await auditTx(tx, { ...ctx, actorUserId: user.id, actorRole: user.role }, {
      action: "team.accept",
      entityType: "user",
      entityId: user.id,
      salonId: invitation.salonId,
      before: { role: user.role },
      after: { accountRole: role, branchRole: invitation.role, invitationId: invitation.id },
    });
    return role;
  });

  const owner = await prisma.user.findUnique({
    where: { id: invitation.salon.owner.userId },
    select: { name: true, email: true },
  });
  if (owner) {
    await sendEmail(
      owner.email,
      `${user.name} joined ${invitation.salon.name}`,
      getTeamJoinedTemplate({
        ownerName: owner.name,
        memberName: user.name,
        memberEmail: user.email,
        salonName: invitation.salon.name,
        role: invitation.role,
      }),
    );
  }

  return {
    salonId: invitation.salonId,
    salonName: invitation.salon.name,
    role: invitation.role,
    accountRole,
  };
};

export const TeamService = {
  listMembers,
  updateMember,
  removeMember,
  leave,
  invite,
  listInvitations,
  resend,
  revoke,
  preview,
  accept,
};
