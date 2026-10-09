import { AppointmentStatus, Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import config from "../../../../config";
import ApiError from "../../../Error/error";
import prisma from "../../../shared/prisma";
import { audit, auditTx, AuditCtx, systemAuditCtx } from "../../../utils/audit";
import { sendEmail } from "../../../utils/emailSender";
import {
  getAccountBlockedTemplate,
  getAccountReactivatedTemplate,
  getAccountSuspendedTemplate,
} from "../../../utils/emailTemplates";
import { AppointmentService } from "../../Appointment/appointment.service";
import { dhakaToday, toCalendarDate } from "../../Assistant/assistant.availability";
import type { AdminContext } from "../admin.middleware";
import { parseListQuery } from "../admin.query";
import { maskEmail, maskPhone } from "../admin.service";
import { REASON_LABELS, STATUS_REASON_CODES } from "./users.validation";

const DAY = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "YYYY-MM-DD" in Dhaka -> the instant that day starts. */
const dhakaStart = (ymd: string) => new Date(`${ymd}T00:00:00+06:00`);

const pageMeta = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / limit)),
});

/** Bookings that still hold the customer's time (and usually a deposit). */
const upcomingWhere = (customerId: string): Prisma.AppointmentWhereInput => ({
  customerId,
  status: { in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED] },
  appointmentDate: { gte: toCalendarDate(dhakaToday()) },
});

// ---------------------------------------------------------------- list

type ListQuery = Record<string, string | undefined>;

const listWhere = (query: ListQuery, q: string | undefined, withRole: boolean) => {
  const and: Prisma.UserWhereInput[] = [{ isDeleted: false }];

  if (query.includeTest !== "true") and.push({ isTest: false });
  if (q) {
    and.push(
      UUID.test(q)
        ? { id: q }
        : {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
              { phone: { contains: q } },
            ],
          },
    );
  }
  if (withRole && query.role) and.push({ role: query.role as Prisma.EnumUserRoleFilter["equals"] });
  if (query.status) and.push({ status: query.status as Prisma.EnumUserStatusFilter["equals"] });
  if (query.verified) and.push({ emailVerified: query.verified === "true" });
  if (query.from || query.to) {
    and.push({
      createdAt: {
        ...(query.from ? { gte: dhakaStart(query.from) } : {}),
        ...(query.to ? { lt: new Date(dhakaStart(query.to).getTime() + DAY) } : {}),
      },
    });
  }
  if (query.hasBookings) {
    and.push({ appointments: query.hasBookings === "true" ? { some: {} } : { none: {} } });
  }
  if (query.provider === "GOOGLE") and.push({ authIdentities: { some: { provider: "GOOGLE" } } });
  if (query.provider === "PASSWORD") and.push({ password: { not: null } });

  return { AND: and } satisfies Prisma.UserWhereInput;
};

const listUsers = async (query: ListQuery) => {
  const { skip, take, orderBy, q, page, limit } = parseListQuery(query, {
    sortable: ["createdAt", "name", "lastActiveAt"],
    defaultSort: { field: "createdAt", order: "desc" },
  });
  const [field, order] = Object.entries(orderBy)[0];
  const sort: Prisma.UserOrderByWithRelationInput[] = [
    field === "lastActiveAt"
      ? { lastActiveAt: { sort: order, nulls: "last" } }
      : { [field]: order },
    { id: "asc" },
  ];

  const where = listWhere(query, q, true);
  const [rows, total, byRole] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: sort,
      skip,
      take,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        profilePhoto: true,
        role: true,
        status: true,
        emailVerified: true,
        isTest: true,
        createdAt: true,
        lastActiveAt: true,
        suspendedUntil: true,
        _count: { select: { appointments: true } },
        wallet: { select: { balance: true } },
      },
    }),
    prisma.user.count({ where }),
    prisma.user.groupBy({
      by: ["role"],
      where: listWhere(query, q, false),
      _count: { _all: true },
    }),
  ]);

  return {
    meta: {
      ...pageMeta(page, limit, total),
      roleCounts: Object.fromEntries(byRole.map((r) => [r.role, r._count._all])),
    },
    // Lists always mask; the full contact is on the user's page with users.view_pii.
    data: rows.map(({ _count, wallet, email, phone, ...u }) => ({
      ...u,
      email: maskEmail(email),
      phone: maskPhone(phone),
      bookings: _count.appointments,
      walletBalanceMinor: wallet?.balance ?? 0,
    })),
  };
};

// ---------------------------------------------------------------- 360

const getUser = async (admin: AdminContext, id: string) => {
  const user = await prisma.user.findFirst({
    where: { id, isDeleted: false },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      address: true,
      gender: true,
      dateOfBirth: true,
      profilePhoto: true,
      role: true,
      status: true,
      statusReason: true,
      statusChangedAt: true,
      suspendedUntil: true,
      lastActiveAt: true,
      emailVerified: true,
      emailVerifiedAt: true,
      isTest: true,
      createdAt: true,
      password: true,
      authIdentities: { select: { provider: true, createdAt: true, lastUsedAt: true } },
      mfa: { select: { enabledAt: true } },
      admin: { select: { adminRole: true } },
      agent: { select: { division: true, district: true, area: true } },
      salonOwner: {
        select: {
          applicationStatus: true,
          salons: {
            where: { isDeleted: false },
            select: { id: true, name: true, status: true, area: true, district: true },
          },
        },
      },
      staff: { select: { salon: { select: { id: true, name: true, status: true } } } },
      wallet: { select: { balance: true, heldBalance: true, isFrozen: true } },
      _count: { select: { appointments: true, reviews: true } },
    },
  });
  if (!user) throw new ApiError(StatusCodes.NOT_FOUND, "User not found");

  const [byStatus, upcoming] = await Promise.all([
    prisma.appointment.groupBy({
      by: ["status"],
      where: { customerId: id },
      _count: { _all: true },
    }),
    prisma.appointment.count({ where: upcomingWhere(id) }),
  ]);
  const count = (s: AppointmentStatus) => byStatus.find((b) => b.status === s)?._count._all ?? 0;

  const pii = admin.permissions.includes("users.view_pii");
  const staffAccount = user.role === "ADMIN" || user.role === "AGENT";

  return {
    id: user.id,
    name: user.name,
    email: pii ? user.email : maskEmail(user.email),
    phone: pii ? user.phone : maskPhone(user.phone),
    address: pii ? user.address : null,
    dateOfBirth: pii ? user.dateOfBirth : null,
    gender: user.gender,
    piiMasked: !pii,
    profilePhoto: user.profilePhoto,
    role: user.role,
    status: user.status,
    statusReason: user.statusReason,
    statusChangedAt: user.statusChangedAt,
    suspendedUntil: user.suspendedUntil,
    lastActiveAt: user.lastActiveAt,
    emailVerified: user.emailVerified,
    emailVerifiedAt: user.emailVerifiedAt,
    isTest: user.isTest,
    createdAt: user.createdAt,
    signInMethods: {
      password: !!user.password,
      identities: user.authIdentities,
    },
    mfa: staffAccount ? { enabled: !!user.mfa?.enabledAt, enabledAt: user.mfa?.enabledAt ?? null } : null,
    adminRole: user.admin?.adminRole ?? null,
    agentArea: user.agent,
    ownerApplication: user.salonOwner?.applicationStatus ?? null,
    ownedSalons: user.salonOwner?.salons ?? [],
    worksAt: user.staff?.salon ?? null,
    counts: {
      bookings: user._count.appointments,
      upcoming,
      completed: count("COMPLETED"),
      cancelled: count("CANCELLED"),
      noShow: count("NO_SHOW"),
      reviews: user._count.reviews,
    },
    wallet: user.wallet
      ? {
          balanceMinor: user.wallet.balance,
          heldMinor: user.wallet.heldBalance,
          isFrozen: user.wallet.isFrozen,
        }
      : null,
  };
};

const assertExists = async (id: string) => {
  const found = await prisma.user.findFirst({ where: { id, isDeleted: false }, select: { id: true } });
  if (!found) throw new ApiError(StatusCodes.NOT_FOUND, "User not found");
};

const listBookings = async (id: string, query: ListQuery) => {
  await assertExists(id);
  const { skip, take, orderBy, page, limit } = parseListQuery(query, {
    sortable: ["appointmentDate", "createdAt"],
    defaultSort: { field: "appointmentDate", order: "desc" },
  });
  const where = { customerId: id };
  const [rows, total] = await Promise.all([
    prisma.appointment.findMany({
      where,
      orderBy: [orderBy, { startTime: "desc" }],
      skip,
      take,
      select: {
        id: true,
        appointmentDate: true,
        startTime: true,
        endTime: true,
        status: true,
        totalMinor: true,
        depositMinor: true,
        depositStatus: true,
        createdAt: true,
        salon: { select: { id: true, name: true } },
        service: { select: { id: true, name: true } },
      },
    }),
    prisma.appointment.count({ where }),
  ]);
  return { meta: pageMeta(page, limit, total), data: rows };
};

const listWallet = async (id: string, query: ListQuery) => {
  await assertExists(id);
  const { skip, take, page, limit } = parseListQuery(query, {
    sortable: ["createdAt"],
    defaultSort: { field: "createdAt", order: "desc" },
  });
  const wallet = await prisma.wallet.findUnique({
    where: { userId: id },
    select: { id: true, balance: true, heldBalance: true, isFrozen: true, currency: true },
  });
  if (!wallet) return { meta: pageMeta(page, limit, 0), data: { wallet: null, transactions: [] } };

  const [rows, total] = await Promise.all([
    prisma.walletTransaction.findMany({
      where: { walletId: wallet.id },
      orderBy: { createdAt: "desc" },
      skip,
      take,
      select: {
        id: true,
        type: true,
        amount: true,
        balanceAfter: true,
        heldAfter: true,
        description: true,
        referenceType: true,
        referenceId: true,
        createdAt: true,
      },
    }),
    prisma.walletTransaction.count({ where: { walletId: wallet.id } }),
  ]);

  return {
    meta: pageMeta(page, limit, total),
    data: {
      wallet: {
        balanceMinor: wallet.balance,
        heldMinor: wallet.heldBalance,
        isFrozen: wallet.isFrozen,
        currency: wallet.currency,
      },
      transactions: rows.map(({ amount, balanceAfter, heldAfter, ...t }) => ({
        ...t,
        amountMinor: amount,
        balanceAfterMinor: balanceAfter,
        heldAfterMinor: heldAfter,
      })),
    },
  };
};

const listReviews = async (id: string, query: ListQuery) => {
  await assertExists(id);
  const { skip, take, page, limit } = parseListQuery(query, {
    sortable: ["createdAt"],
    defaultSort: { field: "createdAt", order: "desc" },
  });
  const where = { customerId: id };
  const [rows, total] = await Promise.all([
    prisma.review.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      select: {
        id: true,
        rating: true,
        comment: true,
        createdAt: true,
        appointmentId: true,
        salon: { select: { id: true, name: true } },
      },
    }),
    prisma.review.count({ where }),
  ]);
  return { meta: pageMeta(page, limit, total), data: rows };
};

/** Audit rows about the account, plus the ones it wrote itself. */
const listActivity = async (id: string, query: ListQuery) => {
  await assertExists(id);
  const { skip, take, page, limit } = parseListQuery(query, {
    sortable: ["createdAt"],
    defaultSort: { field: "createdAt", order: "desc" },
  });
  const where: Prisma.AuditLogWhereInput = { OR: [{ entityId: id }, { actorUserId: id }] };
  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        actorUserId: true,
        actorRole: true,
        source: true,
        before: true,
        after: true,
        reason: true,
        createdAt: true,
      },
    }),
    prisma.auditLog.count({ where }),
  ]);

  const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter((a): a is string => !!a))];
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
    : [];
  const names = new Map(actors.map((a) => [a.id, a.name]));

  return {
    meta: pageMeta(page, limit, total),
    data: rows.map((r) => ({
      ...r,
      actorName: r.actorUserId ? (names.get(r.actorUserId) ?? null) : r.source === "job" ? "System" : null,
    })),
  };
};

// ---------------------------------------------------------------- actions

const getImpact = async (id: string) => {
  await assertExists(id);
  const [upcomingBookings, held, owner] = await Promise.all([
    prisma.appointment.count({ where: upcomingWhere(id) }),
    prisma.appointment.aggregate({
      where: { ...upcomingWhere(id), depositStatus: "HELD" },
      _sum: { depositMinor: true },
    }),
    prisma.salonOwner.findUnique({
      where: { userId: id },
      select: {
        salons: {
          where: { isDeleted: false, status: "ACTIVE" },
          select: { id: true, name: true, status: true },
        },
      },
    }),
  ]);
  const salons = owner?.salons ?? [];
  return {
    upcomingBookings,
    heldDepositsMinor: held._sum.depositMinor ?? 0,
    ownedSalons: salons.length,
    salons,
  };
};

const loadTarget = async (id: string) => {
  const user = await prisma.user.findFirst({
    where: { id, isDeleted: false },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      status: true,
      suspendedUntil: true,
      emailVerified: true,
      salonOwner: { select: { id: true } },
    },
  });
  if (!user) throw new ApiError(StatusCodes.NOT_FOUND, "User not found");
  return user;
};
type Target = Awaited<ReturnType<typeof loadTarget>>;

/** Never on yourself; admin accounts belong to the team page. */
const assertManageable = (admin: AdminContext, target: Target) => {
  if (target.id === admin.userId) {
    throw new ApiError(StatusCodes.CONFLICT, "You cannot do this to your own account");
  }
  if (target.role === "ADMIN") {
    throw new ApiError(StatusCodes.CONFLICT, "Admin accounts are managed from the team page");
  }
};

const notifyStatus = (
  target: Pick<Target, "name" | "email">,
  status: "ACTIVE" | "SUSPENDED" | "BLOCKED",
  reason: string,
  until: Date | null,
) => {
  const contactUrl = `${config.frontend_url}/contact`;
  const [subject, html] =
    status === "SUSPENDED"
      ? ["Your SalonKhuji account is suspended", getAccountSuspendedTemplate({ name: target.name, reason, until, contactUrl })]
      : status === "BLOCKED"
        ? ["Your SalonKhuji account is blocked", getAccountBlockedTemplate({ name: target.name, reason, contactUrl })]
        : [
            "Your SalonKhuji account is active again",
            getAccountReactivatedTemplate({ name: target.name, signInUrl: `${config.frontend_url}/login` }),
          ];
  // sendEmail never throws; the catch is belt and braces so a mail problem
  // can never fail the status change it reports.
  void sendEmail(target.email, subject, html).catch(() => undefined);
};

type StatusInput = {
  status: "ACTIVE" | "SUSPENDED" | "BLOCKED";
  until?: Date;
  reasonCode: (typeof STATUS_REASON_CODES)[number];
  note?: string;
  notify: boolean;
  cancelUpcoming: boolean;
  suspendSalons: boolean;
};

const updateStatus = async (
  admin: AdminContext,
  ctx: AuditCtx | undefined,
  id: string,
  input: StatusInput,
) => {
  const target = await loadTarget(id);
  assertManageable(admin, target);
  if (input.status === "ACTIVE" && target.status === "ACTIVE") {
    throw new ApiError(StatusCodes.CONFLICT, "This account is already active");
  }

  const reason = input.note
    ? `${REASON_LABELS[input.reasonCode]}: ${input.note}`
    : REASON_LABELS[input.reasonCode];
  const now = new Date();
  const until = input.status === "SUSPENDED" ? (input.until ?? null) : null;
  const restricting = input.status !== "ACTIVE";

  // The owner's live salons are suspended with them (hidden everywhere).
  const salonIds =
    restricting && input.suspendSalons && target.salonOwner
      ? (
          await prisma.salon.findMany({
            where: { ownerId: target.salonOwner.id, isDeleted: false, status: "ACTIVE" },
            select: { id: true },
          })
        ).map((s) => s.id)
      : [];

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id },
      data: {
        status: input.status,
        statusReason: reason,
        statusChangedAt: now,
        suspendedUntil: until,
        // The status check already refuses every request; the bump keeps old
        // tokens dead after a later reactivation too.
        ...(restricting ? { sessionVersion: { increment: 1 } } : {}),
      },
    });
    if (salonIds.length) {
      await tx.salon.updateMany({
        where: { id: { in: salonIds } },
        data: { status: "SUSPENDED", statusReason: reason, statusChangedAt: now, statusChangedById: admin.userId },
      });
    }
  });

  // Each booking is its own transaction: one that changed meanwhile (409)
  // must not undo the rest.
  let cancelledBookings = 0;
  let cancelFailed = 0;
  if (restricting && input.cancelUpcoming) {
    const upcoming = await prisma.appointment.findMany({
      where: upcomingWhere(id),
      select: { id: true },
    });
    for (const booking of upcoming) {
      try {
        await AppointmentService.cancelByAdmin(
          booking.id,
          `Cancelled by SalonKhuji: account ${input.status.toLowerCase()}`,
        );
        cancelledBookings++;
      } catch (error) {
        cancelFailed++;
        console.error(`[admin] could not cancel booking ${booking.id}`, error);
      }
    }
  }

  await audit(ctx, {
    action:
      input.status === "ACTIVE" ? "user.reactivate" : input.status === "SUSPENDED" ? "user.suspend" : "user.block",
    entityType: "user",
    entityId: id,
    before: { status: target.status, suspendedUntil: target.suspendedUntil },
    after: {
      status: input.status,
      suspendedUntil: until,
      reasonCode: input.reasonCode,
      notified: input.notify,
      ...(cancelledBookings || cancelFailed ? { cancelledBookings, cancelFailed } : {}),
      ...(salonIds.length ? { inactivatedSalons: salonIds } : {}),
    },
    reason,
  });

  if (input.notify) notifyStatus(target, input.status, reason, until);

  return {
    id,
    status: input.status,
    statusReason: reason,
    suspendedUntil: until,
    cancelledBookings,
    cancelFailed,
    inactivatedSalons: salonIds.length,
  };
};

const revokeSessions = async (
  admin: AdminContext,
  ctx: AuditCtx | undefined,
  id: string,
  reason?: string,
) => {
  const target = await loadTarget(id);
  if (target.id === admin.userId) {
    throw new ApiError(StatusCodes.CONFLICT, "Use Sign out on your own devices instead");
  }
  if (target.role === "ADMIN" && !admin.permissions.includes("team.manage")) {
    throw new ApiError(StatusCodes.CONFLICT, "Admin accounts are managed from the team page");
  }
  await prisma.user.update({ where: { id }, data: { sessionVersion: { increment: 1 } } });
  await audit(ctx, { action: "user.revoke_sessions", entityType: "user", entityId: id, reason });
  return { id };
};

const verifyEmail = async (admin: AdminContext, ctx: AuditCtx | undefined, id: string, reason: string) => {
  const target = await loadTarget(id);
  assertManageable(admin, target);
  if (target.emailVerified) throw new ApiError(StatusCodes.CONFLICT, "This email is already verified");

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { emailVerified: true, emailVerifiedAt: new Date() } });
    await auditTx(tx, ctx, {
      action: "user.verify_email",
      entityType: "user",
      entityId: id,
      before: { emailVerified: false },
      after: { emailVerified: true },
      reason,
    });
  });
  return { id, emailVerified: true };
};

const updateRole = async (
  admin: AdminContext,
  ctx: AuditCtx | undefined,
  id: string,
  role: "CUSTOMER" | "STAFF" | "SALON_OWNER",
  reason: string,
) => {
  const target = await loadTarget(id);
  assertManageable(admin, target);
  if (target.role === "AGENT") {
    throw new ApiError(StatusCodes.CONFLICT, "Agent accounts are managed from the agents page");
  }
  if (target.role === role) throw new ApiError(StatusCodes.CONFLICT, "The account already has this type");

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id },
      // The dashboard reads the role from the token: a fresh sign-in shows the new one.
      data: { role, sessionVersion: { increment: 1 } },
    });
    if (role === "SALON_OWNER" && !target.salonOwner) {
      await tx.salonOwner.create({ data: { userId: id } });
    }
    await auditTx(tx, ctx, {
      action: "user.role_change",
      entityType: "user",
      entityId: id,
      before: { role: target.role },
      after: { role },
      reason,
    });
  });
  return { id, role };
};

/** Job users.unsuspend: timed suspensions that have run out. */
const unsuspendExpired = async () => {
  const now = new Date();
  const due = await prisma.user.findMany({
    where: { status: "SUSPENDED", suspendedUntil: { lt: now }, isDeleted: false },
    select: { id: true, name: true, email: true, suspendedUntil: true },
    take: 500,
  });

  let lifted = 0;
  for (const user of due) {
    // Conditional, so an admin acting at the same moment wins cleanly.
    const { count } = await prisma.user.updateMany({
      where: { id: user.id, status: "SUSPENDED", suspendedUntil: { lt: now } },
      data: { status: "ACTIVE", statusReason: "Suspension ended", statusChangedAt: now, suspendedUntil: null },
    });
    if (!count) continue;
    lifted++;
    await audit(systemAuditCtx("job"), {
      action: "user.reactivate",
      entityType: "user",
      entityId: user.id,
      before: { status: "SUSPENDED", suspendedUntil: user.suspendedUntil },
      after: { status: "ACTIVE", suspendedUntil: null },
      reason: "Suspension ended",
    });
    notifyStatus(user, "ACTIVE", "Suspension ended", null);
  }

  if (lifted) console.log(`[jobs] users.unsuspend: reactivated ${lifted} account(s)`);
  return lifted;
};

export const AdminUsersService = {
  listUsers,
  getUser,
  listBookings,
  listWallet,
  listReviews,
  listActivity,
  getImpact,
  updateStatus,
  revokeSessions,
  verifyEmail,
  updateRole,
  unsuspendExpired,
  notifyAccountStatus: notifyStatus,
};
