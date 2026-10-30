import {
  ExpertVerification,
  Gender,
  HomeExpert,
  HomeServiceProfile,
  HomeServiceStatus,
  Prisma,
} from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { AuditCtx, auditTx, diff } from "../../utils/audit";
import { notifyHomeDecision } from "./home.notify";
import {
  audienceOf,
  auditExpert,
  DOC_KINDS,
  docsPresent,
  expertView,
  signedDocUrls,
} from "./home.expertSetup";
import { cancelBranchUpcoming, rehomeExpertBookings } from "./home.cancel";
import { branchChecklist } from "./home.owner";

/**
 * Back office for Home Service, under /admin/home-service: the branch approval
 * queue and expert verification. Every write is audited in its transaction;
 * every document view is audited before the URLs are signed.
 */

const PAGE_SIZE = 20;

const notFound = () => new ApiError(StatusCodes.NOT_FOUND, "Not found");
const invalidState = (message: string) => ApiError.withCode(StatusCodes.CONFLICT, message, "INVALID_STATE");

const pageOf = (raw: unknown) => Math.max(1, Math.min(10_000, Number(raw) || 1));
const pageMeta = (page: number, total: number) => ({
  page,
  limit: PAGE_SIZE,
  total,
  totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
});

// ---------------------------------------------------------------------------
// Branch profiles
// ---------------------------------------------------------------------------

/** GET /admin/home-service/profiles */
export const listProfiles = async (query: Record<string, unknown>) => {
  const status = (query.status as HomeServiceStatus | undefined) ?? HomeServiceStatus.PENDING_REVIEW;
  const page = pageOf(query.page);
  const where: Prisma.HomeServiceProfileWhereInput = { status };
  const [total, rows] = await Promise.all([
    prisma.homeServiceProfile.count({ where }),
    prisma.homeServiceProfile.findMany({
      where,
      // The review queue is first in, first out; the others show the latest change first.
      orderBy: { updatedAt: status === HomeServiceStatus.PENDING_REVIEW ? "asc" : "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        salon: {
          select: {
            id: true,
            name: true,
            audience: true,
            status: true,
            area: true,
            district: true,
            isTest: true,
            owner: { select: { id: true, user: { select: { name: true, email: true } } } },
          },
        },
      },
    }),
  ]);

  const salonIds = rows.map((r) => r.salonId);
  const counts = salonIds.length
    ? await prisma.homeExpert.groupBy({
        by: ["salonId", "audience", "verification"],
        where: { salonId: { in: salonIds }, removedAt: null },
        _count: true,
      })
    : [];
  const checklists = await Promise.all(rows.map((r) => branchChecklist(r.salonId, r)));

  const data = rows.map((r, i) => {
    const mine = counts.filter((c) => c.salonId === r.salonId);
    const tally = (audience: string) => {
      const out: Record<string, number> = {};
      for (const c of mine) if (c.audience === audience) out[c.verification] = c._count;
      return out;
    };
    return {
      ...r,
      salon: {
        id: r.salon.id,
        name: r.salon.name,
        audience: r.salon.audience,
        status: r.salon.status,
        area: r.salon.area,
        district: r.salon.district,
        isTest: r.salon.isTest,
      },
      owner: r.salon.owner && { id: r.salon.owner.id, name: r.salon.owner.user.name, email: r.salon.owner.user.email },
      sides: { ladies: r.ladiesEnabled, gents: r.gentsEnabled },
      checklist: checklists[i],
      experts: { LADIES: tally("LADIES"), GENTS: tally("GENTS") },
    };
  });
  return { meta: pageMeta(page, total), data };
};

const profileSnapshot = (p: HomeServiceProfile | null) =>
  p && {
    isOn: p.isOn,
    status: p.status,
    everApproved: p.everApproved,
    statusReason: p.statusReason,
    suspendedReason: p.suspendedReason,
  };

const moveProfile = async (
  ctx: AuditCtx | undefined,
  id: string,
  opts: {
    from: HomeServiceStatus[];
    action: string;
    reason?: string | null;
    data: (before: HomeServiceProfile) => Prisma.HomeServiceProfileUpdateManyMutationInput;
  },
) =>
  prisma.$transaction(async (tx) => {
    const before = await tx.homeServiceProfile.findUnique({ where: { id } });
    if (!before) throw notFound();
    if (!opts.from.includes(before.status)) {
      throw invalidState(`This branch is ${before.status.toLowerCase().replace("_", " ")}.`);
    }
    const { count } = await tx.homeServiceProfile.updateMany({
      where: { id, status: before.status },
      data: opts.data(before),
    });
    if (count === 0) throw invalidState("This branch changed meanwhile. Reload and try again.");
    const after = await tx.homeServiceProfile.findUniqueOrThrow({ where: { id } });
    const d = diff(profileSnapshot(before), profileSnapshot(after));
    await auditTx(tx, ctx, {
      action: opts.action,
      entityType: "home_service_profile",
      entityId: id,
      salonId: after.salonId,
      before: d.before,
      after: d.after,
      reason: opts.reason || null,
    });
    return after;
  });

const reviewedBy = (ctx: AuditCtx | undefined) => ({ reviewedById: ctx?.actorUserId ?? null, reviewedAt: new Date() });

export const approveProfile = async (ctx: AuditCtx | undefined, id: string, reason?: string) => {
  const after = await moveProfile(ctx, id, {
    from: [HomeServiceStatus.PENDING_REVIEW],
    action: "homeService.profile_approve",
    reason,
    data: () => ({ status: HomeServiceStatus.ACTIVE, everApproved: true, statusReason: null, ...reviewedBy(ctx) }),
  });
  notifyHomeDecision(after.salonId, "branch_approved");
  return after;
};

/** The owner fixes the checklist and turns on again, which re-enters the queue. */
export const rejectProfile = async (ctx: AuditCtx | undefined, id: string, reason: string) => {
  const after = await moveProfile(ctx, id, {
    from: [HomeServiceStatus.PENDING_REVIEW],
    action: "homeService.profile_reject",
    reason,
    data: () => ({ status: HomeServiceStatus.REJECTED, statusReason: reason, isOn: false, ...reviewedBy(ctx) }),
  });
  notifyHomeDecision(after.salonId, "branch_rejected", reason);
  return after;
};

/** Overrides the owner's switch: a SUSPENDED branch is never bookable and can't be turned on. */
export const suspendProfile = async (ctx: AuditCtx | undefined, id: string, reason: string) => {
  const after = await moveProfile(ctx, id, {
    from: [HomeServiceStatus.DRAFT, HomeServiceStatus.PENDING_REVIEW, HomeServiceStatus.ACTIVE, HomeServiceStatus.REJECTED],
    action: "homeService.profile_suspend",
    reason,
    data: () => ({ status: HomeServiceStatus.SUSPENDED, suspendedReason: reason, ...reviewedBy(ctx) }),
  });
  // Every upcoming visit of the branch ends with a full refund; visits under way go ahead.
  const upcoming = await cancelBranchUpcoming(after.salonId, "SYSTEM_CANCEL", {
    ctx,
    actorRole: "ADMIN",
    reason: `Home Service suspended: ${reason}`,
    action: "homeService.booking_system_cancel",
  });
  notifyHomeDecision(after.salonId, "branch_suspended", reason);
  return { ...after, upcoming };
};

export const unsuspendProfile = async (ctx: AuditCtx | undefined, id: string, reason?: string) =>
  moveProfile(ctx, id, {
    from: [HomeServiceStatus.SUSPENDED],
    action: "homeService.profile_unsuspend",
    reason,
    data: (before) => ({
      status: before.everApproved
        ? HomeServiceStatus.ACTIVE
        : before.isOn
          ? HomeServiceStatus.PENDING_REVIEW
          : HomeServiceStatus.DRAFT,
      suspendedReason: null,
      ...reviewedBy(ctx),
    }),
  });

// ---------------------------------------------------------------------------
// Experts
// ---------------------------------------------------------------------------

const expertInclude = {
  offerings: { select: { offeringId: true } },
  salon: { select: { id: true, name: true, audience: true } },
  staff: { select: { userId: true, user: { select: { name: true, profilePhoto: true, gender: true } } } },
} satisfies Prisma.HomeExpertInclude;

type ExpertWithRefs = Prisma.HomeExpertGetPayload<{ include: typeof expertInclude }>;

const adminExpertView = ({ salon, staff, ...e }: ExpertWithRefs) => ({
  ...expertView(e),
  salon,
  staff: { name: staff.user.name, photo: staff.user.profilePhoto, userGender: staff.user.gender },
});

/** GET /admin/home-service/experts */
export const listExperts = async (query: Record<string, unknown>) => {
  const verification = (query.verification as ExpertVerification | undefined) ?? ExpertVerification.PENDING;
  const page = pageOf(query.page);
  const where: Prisma.HomeExpertWhereInput = { verification, removedAt: null };
  const [total, rows] = await Promise.all([
    prisma.homeExpert.count({ where }),
    prisma.homeExpert.findMany({
      where,
      orderBy:
        verification === ExpertVerification.PENDING ? { submittedAt: "asc" } : { updatedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: expertInclude,
    }),
  ]);
  return { meta: pageMeta(page, total), data: rows.map(adminExpertView) };
};

/** GET /admin/home-service/experts/:id/documents: audited, then 5-minute signed URLs. */
export const expertDocuments = async (ctx: AuditCtx | undefined, id: string) => {
  const expert = await prisma.homeExpert.findUnique({ where: { id }, include: expertInclude });
  if (!expert) throw notFound();
  // The audit row commits first: no record, no URLs.
  await prisma.$transaction((tx) =>
    auditTx(tx, ctx, {
      action: "home.expert.documents.viewed",
      entityType: "home_expert",
      entityId: id,
      salonId: expert.salonId,
      after: { docs: docsPresent(expert), verification: expert.verification },
    }),
  );
  const { documents, expiresAt } = await signedDocUrls(expert);
  return {
    expert: adminExpertView(expert),
    declaredGender: expert.gender,
    documents,
    expiresAt,
  };
};

const moveExpert = async (
  ctx: AuditCtx | undefined,
  id: string,
  opts: {
    from: ExpertVerification[];
    action: string;
    reason?: string | null;
    data: Prisma.HomeExpertUpdateManyMutationInput;
    before?: (tx: Prisma.TransactionClient, expert: HomeExpert) => Promise<void>;
    after?: (tx: Prisma.TransactionClient, expert: HomeExpert) => Promise<void>;
  },
) =>
  prisma.$transaction(async (tx) => {
    const before = await tx.homeExpert.findFirst({ where: { id, removedAt: null } });
    if (!before) throw notFound();
    if (!opts.from.includes(before.verification)) {
      throw invalidState(`This expert is ${before.verification.toLowerCase()}.`);
    }
    await opts.before?.(tx, before);
    const { count } = await tx.homeExpert.updateMany({
      where: { id, removedAt: null, verification: before.verification },
      data: opts.data,
    });
    if (count === 0) throw invalidState("This expert changed meanwhile. Reload and try again.");
    const after = await tx.homeExpert.findUniqueOrThrow({ where: { id } });
    await opts.after?.(tx, after);
    await auditExpert(tx, ctx, opts.action, before, after, { reason: opts.reason });
    return after;
  });

const staffNameOf = async (staffId: string) =>
  (await prisma.staff.findUnique({ where: { id: staffId }, select: { user: { select: { name: true } } } }))?.user.name ?? null;

export const verifyExpert = async (ctx: AuditCtx | undefined, id: string, reason?: string) => {
  const after = await moveExpert(ctx, id, {
    from: [ExpertVerification.PENDING, ExpertVerification.SUSPENDED],
    action: "homeService.expert_verify",
    reason,
    data: {
      verification: ExpertVerification.VERIFIED,
      verifiedAt: new Date(),
      verifiedById: ctx?.actorUserId ?? null,
      rejectReason: null,
    },
    before: async (_tx, e) => {
      const missing = DOC_KINDS.filter((k) => !docsPresent(e)[k]);
      if (missing.length) throw new ApiError(StatusCodes.BAD_REQUEST, `Missing documents: ${missing.join(", ")}.`);
    },
    // The checked gender fills a blank profile; it never overwrites what the user set.
    after: async (tx, e) => {
      const staff = await tx.staff.findUnique({ where: { id: e.staffId }, select: { userId: true } });
      if (staff) await tx.user.updateMany({ where: { id: staff.userId, gender: null }, data: { gender: e.gender } });
    },
  });
  notifyHomeDecision(after.salonId, "expert_verified", null, await staffNameOf(after.staffId));
  return expertView(after);
};

export const rejectExpert = async (ctx: AuditCtx | undefined, id: string, reason: string) => {
  const after = await moveExpert(ctx, id, {
    from: [ExpertVerification.PENDING],
    action: "homeService.expert_reject",
    reason,
    data: { verification: ExpertVerification.REJECTED, rejectReason: reason },
  });
  notifyHomeDecision(after.salonId, "expert_rejected", reason, await staffNameOf(after.staffId));
  return expertView(after);
};

export const suspendExpert = async (ctx: AuditCtx | undefined, id: string, reason: string) => {
  const after = await moveExpert(ctx, id, {
    from: [ExpertVerification.PENDING, ExpertVerification.VERIFIED],
    action: "homeService.expert_suspend",
    reason,
    data: { verification: ExpertVerification.SUSPENDED, rejectReason: reason },
  });
  const upcoming = await rehomeExpertBookings(id, "SYSTEM_CANCEL", {
    ctx,
    actorRole: "ADMIN",
    reason: `Expert suspended: ${reason}`,
    action: "homeService.booking_system_cancel",
  });
  return { ...expertView(after), upcoming };
};

/** Admin-only correction: new gender and side, other-side links dropped, re-verification needed. */
export const setExpertGender = async (ctx: AuditCtx | undefined, id: string, gender: Gender, reason: string) => {
  const audience = audienceOf(gender);
  const after = await moveExpert(ctx, id, {
    from: [
      ExpertVerification.DRAFT,
      ExpertVerification.PENDING,
      ExpertVerification.VERIFIED,
      ExpertVerification.REJECTED,
      ExpertVerification.SUSPENDED,
    ],
    action: "homeService.expert_gender",
    reason,
    data: { gender, audience, verification: ExpertVerification.SUSPENDED, rejectReason: reason },
    before: async (tx, e) => {
      if (e.gender === gender) throw new ApiError(StatusCodes.BAD_REQUEST, `This expert is already ${gender.toLowerCase()}.`);
      await tx.homeExpertOffering.deleteMany({ where: { expertId: id, offering: { audience: { not: audience } } } });
    },
  });
  // Now SUSPENDED: the old side's upcoming visits go to another expert or end with a full refund.
  const upcoming = await rehomeExpertBookings(id, "SYSTEM_CANCEL", {
    ctx,
    actorRole: "ADMIN",
    reason: `Expert needs verifying again: ${reason}`,
    action: "homeService.booking_system_cancel",
  });
  return { ...expertView(after), upcoming };
};
