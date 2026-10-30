import {
  BookingPause,
  ExpertVerification,
  HomeAudience,
  HomeServiceProfile,
  HomeServiceStatus,
  LocationAccuracy,
  Prisma,
  Salon,
  SalonAudience,
  SalonStatus,
} from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { AuditCtx, auditTx, diff } from "../../utils/audit";
import { AccessUser, assertOwnerOf, assertSalonPermission, grantAt } from "../../utils/salonAccess";
import { getSetting } from "../../utils/settings";
import { cancelBranchUpcoming } from "./home.cancel";
import { currentPolicy, disclaimersOf, policySnapshotOf } from "./home.policy";
import type {
  CreateOfferingBody,
  PauseBody,
  ResumeBody,
  TurnOffBody,
  TurnOnBody,
  UpdateOfferingBody,
  UpdateProfileBody,
} from "./home.validation";

/**
 * Owner side of Home Service: the per-branch opt-in, branch settings and the
 * Ladies / Gents menu. Nothing exists for a branch until its owner turns it
 * on; reads never create a profile row. On / off / pause is the owner's alone;
 * settings and menu need `homeservice.manage` at the branch.
 */

const SIDES = [HomeAudience.LADIES, HomeAudience.GENTS] as const;
const PAUSE_MAX_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The owner's Policy tab quotes the customer's words; a real one names the booking's own advance. */
const SAMPLE_ADVANCE_MINOR = 50_000;

const notFound = () => new ApiError(StatusCodes.NOT_FOUND, "Not found");

/** The sides a branch may offer at home, from who the salon serves. */
export const allowedSidesOf = (audience: SalonAudience): HomeAudience[] =>
  audience === SalonAudience.LADIES
    ? [HomeAudience.LADIES]
    : audience === SalonAudience.GENTS
      ? [HomeAudience.GENTS]
      : [...SIDES];

// ---------------------------------------------------------------------------
// Platform settings
// ---------------------------------------------------------------------------

export type HomeFlags = { enabled: boolean; ladiesEnabled: boolean; gentsEnabled: boolean };

export const loadHomeFlags = async (): Promise<HomeFlags> => {
  const [enabled, ladiesEnabled, gentsEnabled] = await Promise.all([
    getSetting("homeService.enabled"),
    getSetting("homeService.ladiesEnabled"),
    getSetting("homeService.gentsEnabled"),
  ]);
  return { enabled, ladiesEnabled, gentsEnabled };
};

const loadPlatformCaps = async () => {
  const [
    flags,
    maxRadiusKm,
    travelFeeMaxMinor,
    minOrderMinMinor,
    minOrderMaxMinor,
    dayStartBound,
    dayEndBound,
    ladiesLastStart,
    commissionPercent,
  ] = await Promise.all([
    loadHomeFlags(),
    getSetting("homeService.maxRadiusKm"),
    getSetting("homeService.travelFeeMaxMinor"),
    getSetting("homeService.minOrderMinMinor"),
    getSetting("homeService.minOrderMaxMinor"),
    getSetting("homeService.dayStartBound"),
    getSetting("homeService.dayEndBound"),
    getSetting("homeService.ladiesLastStart"),
    getSetting("homeService.commissionPercent"),
  ]);
  return {
    ...flags,
    maxRadiusKm,
    travelFeeMaxMinor,
    minOrderMinMinor,
    minOrderMaxMinor,
    dayStartBound,
    dayEndBound,
    ladiesLastStart,
    commissionPercent,
  };
};

export const loadPolicyInForce = async () => {
  const [customerCancelPolicy, freeCancelHours, lateCancelPercent, noShowPercent, nonRefundableGraceMinutes, advancePercent] =
    await Promise.all([
      getSetting("homeService.customerCancelPolicy"),
      getSetting("homeService.freeCancelHours"),
      getSetting("homeService.lateCancelPercent"),
      getSetting("homeService.noShowPercent"),
      getSetting("homeService.nonRefundableGraceMinutes"),
      getSetting("homeService.advancePercent"),
    ]);
  return { customerCancelPolicy, freeCancelHours, lateCancelPercent, noShowPercent, nonRefundableGraceMinutes, advancePercent };
};

// ---------------------------------------------------------------------------
// Public visibility (used by the public reads and booking)
// ---------------------------------------------------------------------------

type BookableProfile = Pick<HomeServiceProfile, "isOn" | "ladiesEnabled" | "gentsEnabled" | "status" | "pausedUntil">;
type BookableSalon = Pick<Salon, "status" | "isDeleted" | "bookingPause">;

/** Whether customers may see and book this branch's `audience` side right now. */
export const isBranchBookable = (
  profile: BookableProfile | null | undefined,
  salon: BookableSalon,
  audience: HomeAudience,
  settings: HomeFlags,
  now: Date = new Date(),
): boolean => {
  const platformSide = audience === HomeAudience.LADIES ? settings.ladiesEnabled : settings.gentsEnabled;
  if (!settings.enabled || !platformSide) return false;
  if (!profile?.isOn) return false;
  if (!(audience === HomeAudience.LADIES ? profile.ladiesEnabled : profile.gentsEnabled)) return false;
  if (profile.status !== HomeServiceStatus.ACTIVE) return false;
  if (profile.pausedUntil && profile.pausedUntil > now) return false;
  return salon.status === SalonStatus.ACTIVE && !salon.isDeleted && salon.bookingPause === BookingPause.NONE;
};

// ---------------------------------------------------------------------------
// Profile + checklist
// ---------------------------------------------------------------------------

const virtualProfile = (salonId: string) => ({
  id: null,
  salonId,
  isOn: false,
  ladiesEnabled: false,
  gentsEnabled: false,
  status: HomeServiceStatus.DRAFT,
  everApproved: false,
  pausedUntil: null,
  pauseReason: null,
  suspendedReason: null,
  radiusKm: 5,
  travelFeeMinor: 0,
  minOrderMinor: 50_000,
  travelBufferMin: 30,
  dayStart: "09:00",
  dayEnd: "20:00",
  statusReason: null,
  reviewedAt: null,
  exists: false,
});

const loadSalon = async (salonId: string) => {
  const salon = await prisma.salon.findUnique({
    where: { id: salonId },
    select: { id: true, name: true, audience: true, status: true, isDeleted: true, locationAccuracy: true, bookingPause: true },
  });
  if (!salon || salon.isDeleted) throw notFound();
  return salon;
};
type SalonRow = Awaited<ReturnType<typeof loadSalon>>;

const sideLabel = (side: HomeAudience) => (side === HomeAudience.LADIES ? "Ladies" : "Gents");

export type ChecklistItem = { key: string; ok: boolean; hint: string };

const buildChecklist = async (salon: SalonRow, sides: HomeAudience[]): Promise<ChecklistItem[]> => {
  const [offerings, experts] = await Promise.all([
    prisma.homeServiceOffering.groupBy({
      by: ["audience"],
      where: { salonId: salon.id, isActive: true, isDeleted: false },
      _count: true,
    }),
    prisma.homeExpert.groupBy({
      by: ["audience"],
      where: {
        salonId: salon.id,
        verification: ExpertVerification.VERIFIED,
        isActive: true,
        removedAt: null,
        staff: { isDeleted: false },
      },
      _count: true,
    }),
  ]);
  const count = (rows: Array<{ audience: HomeAudience; _count: number }>, side: HomeAudience) =>
    rows.find((r) => r.audience === side)?._count ?? 0;

  const items: ChecklistItem[] = [
    {
      key: "salonActive",
      ok: salon.status === SalonStatus.ACTIVE && !salon.isDeleted,
      hint: "Your salon must be approved and active.",
    },
    {
      key: "exactLocation",
      ok: salon.locationAccuracy === LocationAccuracy.EXACT,
      hint: "Place an exact map pin for this branch; experts travel from it.",
    },
  ];
  for (const side of sides) {
    const key = side === HomeAudience.LADIES ? "ladies" : "gents";
    items.push(
      {
        key: `${key}Offering`,
        ok: count(offerings, side) > 0,
        hint: `Add at least one active ${sideLabel(side)} at Home service.`,
      },
      {
        key: `${key}Expert`,
        ok: count(experts, side) > 0,
        hint: `Have at least one verified ${sideLabel(side)} expert.`,
      },
    );
  }
  return items;
};

const enabledSides = (p: { ladiesEnabled: boolean; gentsEnabled: boolean }) =>
  SIDES.filter((s) => (s === HomeAudience.LADIES ? p.ladiesEnabled : p.gentsEnabled));

/** GET /owner/profile: the branch's profile (or the virtual default) plus what the owner needs to decide. */
export const getOwnerProfile = async (user: AccessUser, salonId: string) => {
  await assertSalonPermission(user, salonId, "homeservice.manage");
  const salon = await loadSalon(salonId);
  const allowedSides = allowedSidesOf(salon.audience);
  const [row, platform, policyInForce, policy, grant] = await Promise.all([
    prisma.homeServiceProfile.findUnique({ where: { salonId } }),
    loadPlatformCaps(),
    loadPolicyInForce(),
    currentPolicy(),
    grantAt(user, salonId),
  ]);
  const profile = row ? { ...row, exists: true } : virtualProfile(salonId);
  const chosen = enabledSides(profile).filter((s) => allowedSides.includes(s));
  const checklist = await buildChecklist(salon, chosen.length ? chosen : allowedSides);

  return {
    salon: { id: salon.id, name: salon.name, audience: salon.audience, status: salon.status },
    profile,
    allowedSides,
    checklist,
    platform,
    policyInForce,
    policy: {
      ...policySnapshotOf(policy),
      sampleAdvanceMinor: SAMPLE_ADVANCE_MINOR,
      disclaimer: disclaimersOf(policy, SAMPLE_ADVANCE_MINOR),
    },
    bookable: Object.fromEntries(SIDES.map((s) => [s, isBranchBookable(row, salon, s, platform)])),
    canSwitch: grant?.role === "OWNER",
  };
};

/** The checklist as it stands now, for the admin review queue. No access check: callers are admins. */
export const branchChecklist = async (
  salonId: string,
  profile: { ladiesEnabled: boolean; gentsEnabled: boolean } | null,
): Promise<ChecklistItem[]> => {
  const salon = await loadSalon(salonId).catch(() => null);
  if (!salon) return [{ key: "salonActive", ok: false, hint: "Your salon must be approved and active." }];
  const allowedSides = allowedSidesOf(salon.audience);
  const chosen = profile ? enabledSides(profile).filter((s) => allowedSides.includes(s)) : [];
  return buildChecklist(salon, chosen.length ? chosen : allowedSides);
};

// ---------------------------------------------------------------------------
// Owner-only switch
// ---------------------------------------------------------------------------

/** 404 unless the caller owns this branch. */
const ownBranch = async (user: AccessUser, salonId: string) => {
  const { salonIds } = await assertOwnerOf(user);
  if (!salonIds.includes(salonId)) throw notFound();
  return loadSalon(salonId);
};

const snapshot = (p: HomeServiceProfile | null) =>
  p && {
    isOn: p.isOn,
    ladiesEnabled: p.ladiesEnabled,
    gentsEnabled: p.gentsEnabled,
    status: p.status,
    pausedUntil: p.pausedUntil,
    pauseReason: p.pauseReason,
  };

const auditProfile = (
  tx: Prisma.TransactionClient,
  ctx: AuditCtx,
  action: string,
  before: HomeServiceProfile | null,
  after: HomeServiceProfile,
  reason?: string | null,
) => {
  const d = diff(snapshot(before), snapshot(after));
  return auditTx(tx, ctx, {
    action,
    entityType: "home_service_profile",
    entityId: after.id,
    salonId: after.salonId,
    before: d.before,
    after: d.after,
    reason: reason || null,
  });
};

export const turnOn = async (user: AccessUser, ctx: AuditCtx, body: TurnOnBody) => {
  const salon = await ownBranch(user, body.salonId);
  const allowedSides = allowedSidesOf(salon.audience);
  const sides = SIDES.filter((s) => (s === HomeAudience.LADIES ? body.ladies : body.gents));
  const outside = sides.filter((s) => !allowedSides.includes(s));
  if (outside.length) {
    throw ApiError.withCode(
      StatusCodes.BAD_REQUEST,
      `This salon serves ${salon.audience.toLowerCase()} only, so it can't offer ${outside.map(sideLabel).join(" or ")} at Home.`,
      "AUDIENCE_MIXED",
      { allowedSides },
    );
  }

  const before = await prisma.homeServiceProfile.findUnique({ where: { salonId: salon.id } });
  if (before?.status === HomeServiceStatus.SUSPENDED) {
    const e = new ApiError(StatusCodes.BAD_REQUEST, "Home Service is suspended for this branch by SalonKhuji.");
    e.details = { suspendedReason: before.suspendedReason };
    throw e;
  }

  const checklist = await buildChecklist(salon, sides);
  const failing = checklist.filter((c) => !c.ok);
  if (failing.length) {
    throw ApiError.withCode(
      StatusCodes.BAD_REQUEST,
      "Finish the checklist before turning Home Service on.",
      "HOME_SERVICE_OFF_CHECKLIST",
      { failing: failing.map((c) => c.key), checklist },
    );
  }

  const needsReview = !before?.everApproved && (await getSetting("homeService.requireApproval"));
  const data = {
    isOn: true,
    ladiesEnabled: body.ladies,
    gentsEnabled: body.gents,
    ...(needsReview
      ? { status: HomeServiceStatus.PENDING_REVIEW }
      : { status: HomeServiceStatus.ACTIVE, everApproved: true }),
  };

  return prisma.$transaction(async (tx) => {
    const after = await tx.homeServiceProfile.upsert({
      where: { salonId: salon.id },
      create: { salonId: salon.id, ...data },
      update: data,
    });
    await auditProfile(tx, ctx, "homeService.turn_on", before, after, body.reason);
    return after;
  });
};

export const turnOff = async (user: AccessUser, ctx: AuditCtx, body: TurnOffBody) => {
  const salon = await ownBranch(user, body.salonId);
  const before = await prisma.homeServiceProfile.findUnique({ where: { salonId: salon.id } });
  if (!before) return virtualProfile(salon.id);

  // Off first, so nothing new is booked while the upcoming visits are cancelled.
  const after = await prisma.$transaction(async (tx) => {
    const after = await tx.homeServiceProfile.update({
      where: { salonId: salon.id },
      data: {
        isOn: false,
        // Withdraws a first turn-on still waiting for review; an approved branch keeps its status.
        ...(before.status === HomeServiceStatus.PENDING_REVIEW && { status: HomeServiceStatus.DRAFT }),
      },
    });
    await auditProfile(tx, ctx, "homeService.turn_off", before, after, body.reason ?? `upcoming: ${body.upcoming}`);
    return after;
  });
  if (body.upcoming !== "CANCEL") return after;

  // Each visit in its own transaction, full refund (+ the salon's credit); visits under way go ahead.
  const r = await cancelBranchUpcoming(salon.id, "SALON_CANCEL", {
    ctx,
    actorRole: user.role,
    reason: body.reason?.trim() || "Home Service turned off by the salon",
    action: "homeService.booking_salon_cancel",
  });
  return { ...after, cancelled: r.cancelled, refundedMinor: r.refundedMinor, notCancelled: r.failed.length, underWay: r.underWay };
};

export const pause = async (user: AccessUser, ctx: AuditCtx, body: PauseBody) => {
  const salon = await ownBranch(user, body.salonId);
  const now = Date.now();
  const until = body.until ?? new Date(now + PAUSE_MAX_DAYS * DAY_MS);
  if (until.getTime() <= now) throw new ApiError(StatusCodes.BAD_REQUEST, "Pick a time in the future.");
  if (until.getTime() > now + PAUSE_MAX_DAYS * DAY_MS) {
    throw new ApiError(StatusCodes.BAD_REQUEST, `You can pause for at most ${PAUSE_MAX_DAYS} days.`);
  }
  const before = await prisma.homeServiceProfile.findUnique({ where: { salonId: salon.id } });
  if (!before?.isOn) throw new ApiError(StatusCodes.BAD_REQUEST, "Home Service is off for this branch.");

  return prisma.$transaction(async (tx) => {
    const after = await tx.homeServiceProfile.update({
      where: { salonId: salon.id },
      data: { pausedUntil: until, pauseReason: body.reason || null },
    });
    await auditProfile(tx, ctx, "homeService.pause", before, after, body.reason);
    return after;
  });
};

export const resume = async (user: AccessUser, ctx: AuditCtx, body: ResumeBody) => {
  const salon = await ownBranch(user, body.salonId);
  const before = await prisma.homeServiceProfile.findUnique({ where: { salonId: salon.id } });
  if (!before) throw new ApiError(StatusCodes.BAD_REQUEST, "Home Service is off for this branch.");

  return prisma.$transaction(async (tx) => {
    const after = await tx.homeServiceProfile.update({
      where: { salonId: salon.id },
      data: { pausedUntil: null, pauseReason: null },
    });
    await auditProfile(tx, ctx, "homeService.resume", before, after, body.reason);
    return after;
  });
};

// ---------------------------------------------------------------------------
// Branch settings
// ---------------------------------------------------------------------------

const SETTING_FIELDS = ["radiusKm", "travelFeeMinor", "minOrderMinor", "travelBufferMin", "dayStart", "dayEnd"] as const;

/** PUT /owner/profile: new bookings read these; existing ones keep their snapshot. */
export const updateProfile = async (user: AccessUser, ctx: AuditCtx, body: UpdateProfileBody) => {
  await assertSalonPermission(user, body.salonId, "homeservice.manage");
  await loadSalon(body.salonId);
  const caps = await loadPlatformCaps();
  const bad = (message: string) => new ApiError(StatusCodes.BAD_REQUEST, message);

  if (body.radiusKm !== undefined && body.radiusKm > caps.maxRadiusKm) {
    throw bad(`Service radius can be at most ${caps.maxRadiusKm} km.`);
  }
  if (body.travelFeeMinor !== undefined && body.travelFeeMinor > caps.travelFeeMaxMinor) {
    throw bad(
      caps.travelFeeMaxMinor === 0
        ? "Travel fee isn't enabled by SalonKhuji yet."
        : `Travel fee can be at most ৳${caps.travelFeeMaxMinor / 100}.`,
    );
  }
  if (
    body.minOrderMinor !== undefined &&
    (body.minOrderMinor < caps.minOrderMinMinor || body.minOrderMinor > caps.minOrderMaxMinor)
  ) {
    throw bad(`Minimum order must be between ৳${caps.minOrderMinMinor / 100} and ৳${caps.minOrderMaxMinor / 100}.`);
  }

  const before = await prisma.homeServiceProfile.findUnique({ where: { salonId: body.salonId } });
  const base = before ?? virtualProfile(body.salonId);
  const dayStart = body.dayStart ?? base.dayStart;
  const dayEnd = body.dayEnd ?? base.dayEnd;
  if (body.dayStart !== undefined || body.dayEnd !== undefined) {
    // Zero-padded HH:MM compares correctly as text.
    if (dayStart < caps.dayStartBound || dayEnd > caps.dayEndBound) {
      throw bad(`Home hours must fall between ${caps.dayStartBound} and ${caps.dayEndBound}.`);
    }
    if (dayStart >= dayEnd) throw bad("Start time must be before end time.");
  }

  const data: Prisma.HomeServiceProfileUpdateInput = {};
  for (const key of SETTING_FIELDS) if (body[key] !== undefined) Object.assign(data, { [key]: body[key] });

  return prisma.$transaction(async (tx) => {
    const after = await tx.homeServiceProfile.upsert({
      where: { salonId: body.salonId },
      create: { ...(data as Prisma.HomeServiceProfileUncheckedCreateInput), salonId: body.salonId },
      update: data,
    });
    const pick = (p: object | null) =>
      p && Object.fromEntries(SETTING_FIELDS.map((k) => [k, (p as Record<string, unknown>)[k]]));
    const d = diff(pick(before), pick(after));
    await auditTx(tx, ctx, {
      action: "homeService.settings_update",
      entityType: "home_service_profile",
      entityId: after.id,
      salonId: after.salonId,
      before: d.before,
      after: d.after,
    });
    return after;
  });
};

// ---------------------------------------------------------------------------
// Menu (offerings)
// ---------------------------------------------------------------------------

export const listOfferings = async (user: AccessUser, salonId: string, audience?: HomeAudience) => {
  await assertSalonPermission(user, salonId, "homeservice.manage");
  return prisma.homeServiceOffering.findMany({
    where: { salonId, isDeleted: false, ...(audience && { audience }) },
    orderBy: [{ audience: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
  });
};

/** The offering, or 404 when it is deleted or at a branch the caller can't manage. */
const managedOffering = async (user: AccessUser, id: string) => {
  const offering = await prisma.homeServiceOffering.findFirst({ where: { id, isDeleted: false } });
  if (!offering) throw notFound();
  await assertSalonPermission(user, offering.salonId, "homeservice.manage");
  return offering;
};

const auditOffering = (
  tx: Prisma.TransactionClient,
  ctx: AuditCtx,
  action: string,
  before: object | null,
  after: { id: string; salonId: string } & object,
) => {
  const d = diff(before as Record<string, unknown> | null, after as Record<string, unknown>);
  return auditTx(tx, ctx, {
    action,
    entityType: "home_offering",
    entityId: after.id,
    salonId: after.salonId,
    before: d.before,
    after: d.after,
  });
};

export const createOffering = async (user: AccessUser, ctx: AuditCtx, body: CreateOfferingBody) => {
  await assertSalonPermission(user, body.salonId, "homeservice.manage");
  const salon = await loadSalon(body.salonId);
  const allowedSides = allowedSidesOf(salon.audience);
  if (!allowedSides.includes(body.audience)) {
    throw ApiError.withCode(
      StatusCodes.BAD_REQUEST,
      `This salon can't offer ${sideLabel(body.audience)} at Home services.`,
      "AUDIENCE_MIXED",
      { allowedSides },
    );
  }
  return prisma.$transaction(async (tx) => {
    const created = await tx.homeServiceOffering.create({ data: body });
    await auditOffering(tx, ctx, "homeService.offering_create", null, created);
    return created;
  });
};

export const updateOffering = async (user: AccessUser, ctx: AuditCtx, id: string, body: UpdateOfferingBody) => {
  const before = await managedOffering(user, id);
  return prisma.$transaction(async (tx) => {
    const after = await tx.homeServiceOffering.update({ where: { id }, data: body });
    await auditOffering(tx, ctx, "homeService.offering_update", before, after);
    return after;
  });
};

export const toggleOffering = async (user: AccessUser, ctx: AuditCtx, id: string) => {
  const before = await managedOffering(user, id);
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.homeServiceOffering.updateMany({
      where: { id, isActive: before.isActive, isDeleted: false },
      data: { isActive: !before.isActive },
    });
    if (count === 0) throw new ApiError(StatusCodes.CONFLICT, "This service changed meanwhile. Reload and try again.");
    const after = await tx.homeServiceOffering.findUniqueOrThrow({ where: { id } });
    await auditOffering(tx, ctx, "homeService.offering_toggle", before, after);
    return after;
  });
};

/** Soft delete: booking items keep pointing at it; expert links go. */
export const deleteOffering = async (user: AccessUser, ctx: AuditCtx, id: string) => {
  const before = await managedOffering(user, id);
  return prisma.$transaction(async (tx) => {
    const after = await tx.homeServiceOffering.update({ where: { id }, data: { isDeleted: true, isActive: false } });
    await tx.homeExpertOffering.deleteMany({ where: { offeringId: id } });
    await auditOffering(tx, ctx, "homeService.offering_delete", before, after);
    return { id };
  });
};
