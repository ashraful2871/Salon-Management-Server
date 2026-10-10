import { AppointmentStatus } from "@prisma/client";
import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../../Error/error";
import prisma from "../../../shared/prisma";
import { audit, auditTx, AuditCtx } from "../../../utils/audit";
import { dhakaToday, toCalendarDate } from "../../Assistant/assistant.availability";
import { recomputeSalonRating, recomputeStaffRating } from "../../Review/review.service";
import type { AdminContext } from "../admin.middleware";

/**
 * Privacy requests (users.delete, tier 3): a JSON export of what we hold about
 * a person, and anonymizing the account while every money record stays, so
 * wallets, the ledger and finance totals still reconcile afterwards.
 */

const UPCOMING: AppointmentStatus[] = [
  AppointmentStatus.PENDING,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.CHECKED_IN,
  AppointmentStatus.IN_PROGRESS,
];

const loadPerson = async (id: string) => {
  const user = await prisma.user.findFirst({
    where: { id, isDeleted: false },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      gender: true,
      dateOfBirth: true,
      address: true,
      profilePhoto: true,
      role: true,
      status: true,
      emailVerified: true,
      createdAt: true,
      lastActiveAt: true,
      password: true,
    },
  });
  if (!user) throw new ApiError(StatusCodes.NOT_FOUND, "User not found");
  return user;
};

// ---------------------------------------------------------------- export

/**
 * Field names are chosen so the file never carries the words password, secret
 * or token: the booking code is `bookingCode`, sign-in methods are providers.
 * Never included: password hash, sessions, OTPs, MFA, assistant transcripts,
 * idempotency keys, internal support notes.
 */
const buildExport = async (id: string) => {
  const user = await loadPerson(id);
  const { password, ...profile } = user;

  const [identities, appointments, wallet, reviews, tickets, owner] = await Promise.all([
    prisma.authIdentity.findMany({
      where: { userId: id },
      select: { provider: true, createdAt: true, lastUsedAt: true },
    }),
    prisma.appointment.findMany({
      where: { customerId: id },
      orderBy: { appointmentDate: "desc" },
      select: {
        id: true,
        token: true,
        appointmentDate: true,
        startTime: true,
        endTime: true,
        status: true,
        notes: true,
        cancellationReason: true,
        totalMinor: true,
        depositMinor: true,
        depositStatus: true,
        bookedVia: true,
        createdAt: true,
        salon: { select: { id: true, name: true } },
        service: { select: { name: true } },
      },
    }),
    prisma.wallet.findUnique({
      where: { userId: id },
      select: {
        balance: true,
        heldBalance: true,
        currency: true,
        createdAt: true,
        transactions: {
          orderBy: { createdAt: "asc" },
          select: { type: true, amount: true, balanceAfter: true, description: true, referenceType: true, createdAt: true },
        },
      },
    }),
    prisma.review.findMany({
      where: { customerId: id },
      orderBy: { createdAt: "desc" },
      select: { rating: true, comment: true, status: true, createdAt: true, salon: { select: { name: true } } },
    }),
    prisma.supportTicket.findMany({
      where: { OR: [{ userId: id }, { email: { equals: user.email, mode: "insensitive" } }] },
      orderBy: { createdAt: "desc" },
      select: {
        number: true,
        subject: true,
        category: true,
        status: true,
        createdAt: true,
        messages: {
          where: { internal: false },
          orderBy: { createdAt: "asc" },
          select: { authorType: true, body: true, createdAt: true },
        },
      },
    }),
    prisma.salonOwner.findUnique({
      where: { userId: id },
      select: {
        businessName: true,
        businessAddress: true,
        businessPhone: true,
        businessEmail: true,
        documentUrl: true,
        applicationStatus: true,
        rejectionReason: true,
        createdAt: true,
        salons: {
          where: { isDeleted: false },
          select: { id: true, name: true, address: true, area: true, city: true, phone: true, email: true, status: true, createdAt: true },
        },
      },
    }),
  ]);

  const { salons, ...application } = owner ?? { salons: [] };

  return {
    exportedAt: new Date().toISOString(),
    profile,
    signInMethods: [
      ...(password ? [{ provider: "EMAIL" }] : []),
      ...identities.map((i) => ({ provider: i.provider, linkedAt: i.createdAt, lastUsedAt: i.lastUsedAt })),
    ],
    bookings: appointments.map(({ token, salon, service, ...a }) => ({
      ...a,
      bookingCode: token,
      salon: salon.name,
      salonId: salon.id,
      service: service?.name ?? null,
    })),
    wallet: wallet
      ? {
          balanceMinor: wallet.balance,
          heldBalanceMinor: wallet.heldBalance,
          currency: wallet.currency,
          createdAt: wallet.createdAt,
          transactions: wallet.transactions.map((t) => ({
            type: t.type,
            amountMinor: t.amount,
            balanceAfterMinor: t.balanceAfter,
            description: t.description,
            referenceType: t.referenceType,
            createdAt: t.createdAt,
          })),
        }
      : null,
    reviews: reviews.map(({ salon, ...r }) => ({ ...r, salon: salon.name })),
    supportTickets: tickets,
    salonOwnerApplication: owner ? application : null,
    ownedSalons: salons,
  };
};

/** GET /admin/users/:id/export - a JSON download, audited. */
const exportUserData = async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const data = await buildExport(id);
  await audit(req.auditCtx, {
    action: "user.data_export",
    entityType: "user",
    entityId: id,
    after: {
      bookings: data.bookings.length,
      walletTransactions: data.wallet?.transactions.length ?? 0,
      reviews: data.reviews.length,
      supportTickets: data.supportTickets.length,
    },
  });
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="user-${id}.json"`);
  res.setHeader("Cache-Control", "no-store");
  res.status(StatusCodes.OK).send(JSON.stringify(data, null, 2));
};

// ---------------------------------------------------------------- anonymize

/** Field names only: the values being erased never reach the audit log. */
const ERASED_FIELDS = ["name", "email", "phone", "address", "dateOfBirth", "profilePhoto"];

const anonymize = async (
  admin: AdminContext,
  ctx: AuditCtx | undefined,
  id: string,
  input: { reason: string; confirmEmail: string },
) => {
  const user = await loadPerson(id);
  if (user.id === admin.userId) {
    throw new ApiError(StatusCodes.FORBIDDEN, "You cannot anonymize your own account");
  }
  if (user.role === "ADMIN" || user.role === "AGENT") {
    throw new ApiError(StatusCodes.FORBIDDEN, "Admin and agent accounts cannot be anonymized here");
  }
  if (input.confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Type the account's email exactly to confirm");
  }

  const today = toCalendarDate(dhakaToday());
  const [upcoming, salonUpcoming, wallet] = await Promise.all([
    prisma.appointment.count({ where: { customerId: id, status: { in: UPCOMING }, appointmentDate: { gte: today } } }),
    prisma.appointment.count({
      where: { salon: { owner: { userId: id } }, status: { in: UPCOMING }, appointmentDate: { gte: today } },
    }),
    prisma.wallet.findUnique({ where: { userId: id }, select: { balance: true } }),
  ]);
  if (upcoming > 0) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      `${upcoming} upcoming booking${upcoming === 1 ? "" : "s"} still open. Cancel them first.`,
    );
  }
  if (salonUpcoming > 0) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      `Their salons have ${salonUpcoming} upcoming booking${salonUpcoming === 1 ? "" : "s"}. Suspend the salons with "cancel upcoming" first.`,
    );
  }
  if (wallet && wallet.balance > 0) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      "The wallet still has a balance. Refund the top-ups or adjust the wallet to zero first.",
    );
  }

  const rated = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id },
      data: {
        name: "Deleted user",
        email: `deleted+${id}@invalid.local`,
        phone: null,
        address: null,
        dateOfBirth: null,
        profilePhoto: null,
        status: "DELETED",
        statusReason: "Anonymized on request",
        statusChangedAt: new Date(),
        isDeleted: true,
        sessionVersion: { increment: 1 },
      },
    });
    await tx.authIdentity.deleteMany({ where: { userId: id } });
    await tx.userMfa.deleteMany({ where: { userId: id } });
    await tx.otpChallenge.deleteMany({ where: { userId: id } });
    await tx.verificationToken.deleteMany({ where: { userId: id } });
    // Messages cascade with their conversation.
    await tx.assistantConversation.deleteMany({ where: { userId: id } });
    // Keep the star value on the row, drop the words, hide it.
    const published = await tx.review.findMany({
      where: { customerId: id, status: "PUBLISHED" },
      select: { salonId: true, staffId: true },
    });
    const reviews = await tx.review.updateMany({
      where: { customerId: id },
      data: {
        comment: null,
        status: "HIDDEN",
        hiddenReason: "PERSONAL_INFO",
        moderatedById: admin.userId,
        moderatedAt: new Date(),
      },
    });
    // Support threads stay for the record, without the requester's name/email.
    await tx.supportTicket.updateMany({
      where: { userId: id },
      data: { name: "Deleted user", email: `deleted+${id}@invalid.local` },
    });
    await auditTx(tx, ctx, {
      action: "user.anonymize",
      entityType: "user",
      entityId: id,
      before: { fields: ERASED_FIELDS, status: user.status },
      after: { status: "DELETED", reviewsHidden: reviews.count },
      reason: input.reason,
    });
    return published;
  }, { timeout: 15000, maxWait: 10000 });

  // Averages count PUBLISHED reviews only, so every salon and staff member
  // they rated is recomputed - after the commit: a round trip each would
  // outlast the interactive transaction's 5 s timeout, and these figures are
  // a cache that the next review action rebuilds anyway.
  try {
    for (const salonId of new Set(rated.map((r) => r.salonId))) await recomputeSalonRating(prisma, salonId);
    for (const staffId of new Set(rated.flatMap((r) => (r.staffId ? [r.staffId] : [])))) {
      await recomputeStaffRating(prisma, staffId);
    }
  } catch (error) {
    console.error("[privacy] rating recompute after anonymize failed:", error);
  }

  return { id, status: "DELETED" as const };
};

export const AdminUsersPrivacy = { exportUserData, anonymize };
