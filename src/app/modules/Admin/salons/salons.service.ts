import { AppointmentStatus, Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import config from "../../../../config";
import ApiError from "../../../Error/error";
import prisma from "../../../shared/prisma";
import { audit, auditTx, AuditCtx, diff } from "../../../utils/audit";
import { sendEmail } from "../../../utils/emailSender";
import { getSalonStatusTemplate } from "../../../utils/emailTemplates";
import { embeddingModel } from "../../AI-Suggestion/ai.gemini";
import { DOCUMENT_VERSION, indexSalon, scheduleReindex } from "../../AI-Suggestion/ai.indexer";
import { AppointmentService } from "../../Appointment/appointment.service";
import { dhakaToday, toCalendarDate } from "../../Assistant/assistant.availability";
import { SettlementService } from "../../Settlement/settlement.service";
import type { AdminContext } from "../admin.middleware";
import { can, normalizeArea } from "../admin.permissions";
import { parseListQuery } from "../admin.query";
import { maskEmail, maskPhone } from "../admin.service";
import {
  ADMIN_SALON_STATUSES,
  SALON_REASON_FIX,
  SALON_REASON_LABELS,
  SalonReasonCode,
} from "./salons.validation";

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

/** Bookings that still hold a customer's time (and usually a deposit). */
const upcomingWhere = (salonId: string): Prisma.AppointmentWhereInput => ({
  salonId,
  status: { in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED] },
  appointmentDate: { gte: toCalendarDate(dhakaToday()) },
});

/**
 * The area an AGENT is limited to, normalised; null for admins. An agent
 * without an area matches nothing.
 */
const scopeOf = (admin: AdminContext): string | null =>
  admin.accountRole === "AGENT" ? normalizeArea(admin.area ?? "") || "\u0000" : null;

/** A salon outside an agent's area answers 404, as if it did not exist. */
const loadSalon = async (admin: AdminContext, id: string) => {
  const salon = await prisma.salon.findFirst({
    where: { id, isDeleted: false },
    include: { owner: { include: { user: { select: { id: true, name: true, email: true, phone: true, status: true } } } } },
  });
  const scope = scopeOf(admin);
  if (!salon || (scope && normalizeArea(salon.area) !== scope)) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Salon not found");
  }
  return salon;
};

const assertExists = async (id: string) => {
  const found = await prisma.salon.findFirst({ where: { id, isDeleted: false }, select: { id: true } });
  if (!found) throw new ApiError(StatusCodes.NOT_FOUND, "Salon not found");
};

// ---------------------------------------------------------------- list

type ListQuery = Record<string, string | undefined>;

const insensitive = (value: string) => ({ equals: value.trim(), mode: "insensitive" as const });

const listWhere = (query: ListQuery, q: string | undefined, scope: string | null, withStatus: boolean) => {
  const and: Prisma.SalonWhereInput[] = [{ isDeleted: false }];

  if (scope) and.push({ area: insensitive(scope) });
  if (query.includeTest !== "true") and.push({ isTest: false });
  if (q) {
    and.push(
      UUID.test(q)
        ? { id: q }
        : {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { phone: { contains: q } },
              { address: { contains: q, mode: "insensitive" } },
              { area: { contains: q, mode: "insensitive" } },
              { owner: { user: { name: { contains: q, mode: "insensitive" } } } },
              { owner: { user: { email: { contains: q, mode: "insensitive" } } } },
            ],
          },
    );
  }
  if (withStatus && query.status) and.push({ status: query.status as Prisma.EnumSalonStatusFilter["equals"] });
  if (query.division) and.push({ division: insensitive(query.division) });
  if (query.district) and.push({ district: insensitive(query.district) });
  if (query.area) and.push({ area: insensitive(query.area) });
  if (query.location === "EXACT" || query.location === "APPROXIMATE") {
    and.push({ locationAccuracy: query.location, latitude: { not: null }, longitude: { not: null } });
  }
  if (query.location === "NONE") and.push({ OR: [{ latitude: null }, { longitude: null }] });
  if (query.minRating) and.push({ rating: { gte: Number(query.minRating) } });
  if (query.from || query.to) {
    and.push({
      createdAt: {
        ...(query.from ? { gte: dhakaStart(query.from) } : {}),
        ...(query.to ? { lt: new Date(dhakaStart(query.to).getTime() + DAY) } : {}),
      },
    });
  }

  return { AND: and } satisfies Prisma.SalonWhereInput;
};

const listSalons = async (admin: AdminContext, query: ListQuery) => {
  // Pending salons read oldest first: the one waiting longest is next.
  const pending = query.status === "PENDING_APPROVAL";
  const { skip, take, orderBy, q, page, limit } = parseListQuery(query, {
    sortable: ["createdAt", "name", "rating", "waiting"],
    defaultSort: pending ? { field: "waiting", order: "desc" } : { field: "createdAt", order: "desc" },
  });
  const [field, order] = Object.entries(orderBy)[0];
  const sort: Prisma.SalonOrderByWithRelationInput[] = [
    field === "waiting" ? { createdAt: order === "desc" ? "asc" : "desc" } : { [field]: order },
    { id: "asc" },
  ];

  const scope = scopeOf(admin);
  const since = new Date(Date.now() - 30 * DAY);
  const where = listWhere(query, q, scope, true);
  const [rows, total, byStatus] = await Promise.all([
    prisma.salon.findMany({
      where,
      orderBy: sort,
      skip,
      take,
      select: {
        id: true,
        name: true,
        images: true,
        address: true,
        phone: true,
        area: true,
        district: true,
        division: true,
        status: true,
        statusReason: true,
        statusChangedAt: true,
        approvedAt: true,
        latitude: true,
        longitude: true,
        locationAccuracy: true,
        operatingHours: true,
        description: true,
        rating: true,
        totalReviews: true,
        isTest: true,
        createdAt: true,
        owner: { select: { id: true, user: { select: { id: true, name: true, email: true } } } },
        _count: {
          select: {
            services: { where: { isDeleted: false, isActive: true } },
            appointments: { where: { createdAt: { gte: since } } },
          },
        },
      },
    }),
    prisma.salon.count({ where }),
    prisma.salon.groupBy({
      by: ["status"],
      where: listWhere(query, q, scope, false),
      _count: { _all: true },
    }),
  ]);

  // Priced services feed the review checklist; one grouped query for the page.
  const priced = rows.length
    ? await prisma.service.groupBy({
        by: ["salonId"],
        where: { salonId: { in: rows.map((r) => r.id) }, isDeleted: false, isActive: true, priceMinor: { gt: 0 } },
        _count: { _all: true },
      })
    : [];
  const pricedBySalon = new Map(priced.map((p) => [p.salonId, p._count._all]));

  return {
    meta: {
      ...pageMeta(page, limit, total),
      statusCounts: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
    },
    // Lists always mask; the full contact is on the salon's page with users.view_pii.
    data: rows.map(({ _count, owner, images, operatingHours, ...s }) => ({
      ...s,
      coverImage: images[0] ?? null,
      imageCount: images.length,
      hasHours: operatingHours != null && Object.keys(operatingHours as object).length > 0,
      services: _count.services,
      pricedServices: pricedBySalon.get(s.id) ?? 0,
      bookings30d: _count.appointments,
      owner: owner.user ? { id: owner.user.id, name: owner.user.name, email: maskEmail(owner.user.email) } : null,
    })),
  };
};

// ---------------------------------------------------------------- 360

const STATUS_ACTIONS = ["salon.approve", "salon.reject", "salon.suspend", "salon.reactivate", "salon.status_change"];

const actorNames = async (ids: (string | null)[]) => {
  const unique = [...new Set(ids.filter((a): a is string => !!a))];
  const actors = unique.length
    ? await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } })
    : [];
  return new Map(actors.map((a) => [a.id, a.name]));
};

const getSalon = async (admin: AdminContext, id: string) => {
  const salon = await loadSalon(admin, id);
  const since = new Date(Date.now() - 30 * DAY);

  const [services, staff, counters, bookings30d, settled30d, noShows30d, index, history, balance] = await Promise.all([
    prisma.service.count({ where: { salonId: id, isDeleted: false } }),
    prisma.staff.count({ where: { salonId: id, isDeleted: false } }),
    prisma.counter.count({ where: { salonId: id, isDeleted: false } }),
    prisma.appointment.count({ where: { salonId: id, createdAt: { gte: since } } }),
    prisma.appointment.count({
      where: { salonId: id, appointmentDate: { gte: since }, status: { in: ["COMPLETED", "NO_SHOW"] } },
    }),
    prisma.appointment.count({ where: { salonId: id, appointmentDate: { gte: since }, status: "NO_SHOW" } }),
    prisma.$queryRaw<Array<{ hasEmbedding: boolean }>>`
      SELECT (embedding IS NOT NULL) AS "hasEmbedding" FROM salons WHERE id = ${id}`,
    prisma.auditLog.findMany({
      where: { entityType: "salon", entityId: id, action: { in: STATUS_ACTIONS } },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, action: true, actorUserId: true, actorRole: true, before: true, after: true, reason: true, createdAt: true },
    }),
    can(admin, "finance.view") ? SettlementService.getSalonBalance(id) : Promise.resolve(null),
  ]);

  const names = await actorNames(history.map((h) => h.actorUserId));
  const hasEmbedding = index[0]?.hasEmbedding ?? false;
  const stale =
    salon.status === "ACTIVE" &&
    (!hasEmbedding ||
      salon.embeddingModel !== embeddingModel() ||
      !salon.embeddingHash?.startsWith(`${DOCUMENT_VERSION}:`) ||
      !salon.embeddedAt ||
      salon.embeddedAt < salon.updatedAt);

  const pii = can(admin, "users.view_pii");
  const { owner, embeddingHash: _hash, ...rest } = salon;
  return {
    ...rest,
    owner: {
      id: owner.id,
      businessName: owner.businessName,
      applicationStatus: owner.applicationStatus,
      user: {
        id: owner.user.id,
        name: owner.user.name,
        status: owner.user.status,
        email: pii ? owner.user.email : maskEmail(owner.user.email),
        phone: pii ? owner.user.phone : maskPhone(owner.user.phone),
      },
    },
    piiMasked: !pii,
    counts: {
      services,
      staff,
      counters,
      bookings30d,
      noShowRate30d: settled30d ? noShows30d / settled30d : null,
    },
    balance,
    index: { hasEmbedding, embeddingModel: salon.embeddingModel, embeddedAt: salon.embeddedAt, stale },
    statusHistory: history.map((h) => ({
      ...h,
      actorName: h.actorUserId ? (names.get(h.actorUserId) ?? null) : null,
    })),
  };
};

const listServices = async (id: string) => {
  await assertExists(id);
  return prisma.service.findMany({
    where: { salonId: id, isDeleted: false },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      category: true,
      priceMinor: true,
      duration: true,
      isActive: true,
      createdAt: true,
      _count: { select: { appointments: true } },
    },
  });
};

const listTeam = async (admin: AdminContext, id: string) => {
  await assertExists(id);
  const pii = can(admin, "users.view_pii");
  const [staff, counters] = await Promise.all([
    prisma.staff.findMany({
      where: { salonId: id, isDeleted: false },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        speciality: true,
        status: true,
        rating: true,
        totalReviews: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true, profilePhoto: true } },
      },
    }),
    prisma.counter.findMany({
      where: { salonId: id, isDeleted: false },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, code: true, isActive: true },
    }),
  ]);
  return {
    staff: staff.map((s) => ({ ...s, user: { ...s.user, email: pii ? s.user.email : maskEmail(s.user.email) } })),
    counters,
  };
};

const listBookings = async (id: string, query: ListQuery) => {
  await assertExists(id);
  const { skip, take, orderBy, page, limit } = parseListQuery(query, {
    sortable: ["appointmentDate", "createdAt"],
    defaultSort: { field: "appointmentDate", order: "desc" },
  });
  const where: Prisma.AppointmentWhereInput = {
    salonId: id,
    ...(query.status ? { status: query.status as AppointmentStatus } : {}),
  };
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
        customer: { select: { id: true, name: true } },
        service: { select: { id: true, name: true } },
      },
    }),
    prisma.appointment.count({ where }),
  ]);
  return { meta: pageMeta(page, limit, total), data: rows };
};

const listReviews = async (id: string, query: ListQuery) => {
  await assertExists(id);
  const { skip, take, page, limit } = parseListQuery(query, {
    sortable: ["createdAt"],
    defaultSort: { field: "createdAt", order: "desc" },
  });
  const where = { salonId: id };
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
        customer: { select: { id: true, name: true } },
      },
    }),
    prisma.review.count({ where }),
  ]);
  return { meta: pageMeta(page, limit, total), data: rows };
};

const getMoney = async (id: string, query: ListQuery) => {
  await assertExists(id);
  const { skip, take, page, limit } = parseListQuery(query, {
    sortable: ["createdAt"],
    defaultSort: { field: "createdAt", order: "desc" },
  });
  const where = { salonId: id };
  const [balance, entries, total, payouts] = await Promise.all([
    SettlementService.getSalonBalance(id),
    prisma.ledgerEntry.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      select: { id: true, account: true, amountMinor: true, description: true, appointmentId: true, payoutId: true, createdAt: true },
    }),
    prisma.ledgerEntry.count({ where }),
    prisma.payout.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, periodStart: true, periodEnd: true, netMinor: true, status: true, paidAt: true, createdAt: true },
    }),
  ]);
  return { meta: pageMeta(page, limit, total), data: { balance, payouts, entries } };
};

const listActivity = async (id: string, query: ListQuery) => {
  await assertExists(id);
  const { skip, take, page, limit } = parseListQuery(query, {
    sortable: ["createdAt"],
    defaultSort: { field: "createdAt", order: "desc" },
  });
  const where: Prisma.AuditLogWhereInput = { OR: [{ salonId: id }, { entityType: "salon", entityId: id }] };
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
  const names = await actorNames(rows.map((r) => r.actorUserId));
  return {
    meta: pageMeta(page, limit, total),
    data: rows.map((r) => ({
      ...r,
      actorName: r.actorUserId ? (names.get(r.actorUserId) ?? null) : r.source === "job" ? "System" : null,
    })),
  };
};

const getImpact = async (admin: AdminContext, id: string) => {
  await loadSalon(admin, id);
  const [upcomingBookings, held, balance] = await Promise.all([
    prisma.appointment.count({ where: upcomingWhere(id) }),
    prisma.appointment.aggregate({
      where: { ...upcomingWhere(id), depositStatus: "HELD" },
      _sum: { depositMinor: true },
    }),
    SettlementService.getSalonBalance(id),
  ]);
  return {
    upcomingBookings,
    heldDepositsMinor: held._sum.depositMinor ?? 0,
    payableMinor: balance.payableMinor,
  };
};

// ---------------------------------------------------------------- actions

type Salon = Awaited<ReturnType<typeof loadSalon>>;
type AdminStatus = (typeof ADMIN_SALON_STATUSES)[number];

const notifyOwner = (
  salon: Salon,
  kind: "approved" | "rejected" | "suspended" | "reactivated",
  reason: string | null,
  reasonCode?: SalonReasonCode,
) => {
  const link =
    kind === "rejected"
      ? `${config.frontend_url}/dashboard/store/${salon.id}`
      : `${config.frontend_url}/salons/${salon.id}`;
  const subject = {
    approved: `${salon.name} is live on SalonKhuji`,
    rejected: `${salon.name} was not approved`,
    suspended: `${salon.name} is suspended`,
    reactivated: `${salon.name} is live again`,
  }[kind];
  const html = getSalonStatusTemplate({
    kind,
    ownerName: salon.owner.user.name,
    salonName: salon.name,
    reason,
    fixHint: reasonCode ? (SALON_REASON_FIX[reasonCode] ?? null) : null,
    link,
    contactUrl: `${config.frontend_url}/contact`,
  });
  // sendEmail never throws; the catch is belt and braces so a mail problem
  // can never fail the status change it reports.
  void sendEmail(salon.owner.user.email, subject, html).catch(() => undefined);
};

type StatusInput = {
  status: AdminStatus;
  reasonCode?: SalonReasonCode;
  note?: string;
  notify: boolean;
};

/**
 * Every salon status change, from `PATCH /admin/salons/:id/status` and the
 * older `PATCH /salons/:id/status` alike. Approve/reject needs salons.review
 * (agents too, inside their area); suspend/deactivate needs salons.manage.
 */
const updateStatus = async (admin: AdminContext, ctx: AuditCtx | undefined, id: string, input: StatusInput) => {
  const salon = await loadSalon(admin, id);

  const isReview = input.status === "ACTIVE" || input.status === "REJECTED";
  if (!can(admin, isReview ? "salons.review" : "salons.manage")) {
    throw new ApiError(StatusCodes.FORBIDDEN, "Forbidden");
  }
  if (salon.status === input.status) {
    throw new ApiError(StatusCodes.CONFLICT, `This salon is already ${input.status.toLowerCase().replace("_", " ")}`);
  }

  const reason = input.reasonCode
    ? input.note
      ? `${SALON_REASON_LABELS[input.reasonCode]}: ${input.note}`
      : SALON_REASON_LABELS[input.reasonCode]
    : (input.note ?? null);
  const now = new Date();

  const result = await prisma.salon.update({
    where: { id },
    data: {
      status: input.status,
      statusReason: reason,
      statusChangedAt: now,
      statusChangedById: admin.userId,
      ...(input.status === "ACTIVE" && !salon.approvedAt ? { approvedAt: now } : {}),
    },
    select: { id: true, status: true, statusReason: true, statusChangedAt: true, approvedAt: true },
  });

  // Becoming ACTIVE makes a salon searchable; leaving it, unsearchable.
  scheduleReindex(id, "salon.status");

  const wasReviewable = salon.status === "PENDING_APPROVAL" || salon.status === "REJECTED";
  const action =
    input.status === "ACTIVE"
      ? wasReviewable
        ? "salon.approve"
        : "salon.reactivate"
      : input.status === "REJECTED"
        ? "salon.reject"
        : input.status === "SUSPENDED"
          ? "salon.suspend"
          : "salon.status_change";

  await audit(ctx, {
    action,
    entityType: "salon",
    entityId: id,
    salonId: id,
    before: { status: salon.status, statusReason: salon.statusReason },
    after: { status: result.status, reasonCode: input.reasonCode ?? null, notified: input.notify },
    reason,
  });

  if (input.notify) {
    const kind =
      action === "salon.approve"
        ? "approved"
        : action === "salon.reactivate"
          ? "reactivated"
          : action === "salon.reject"
            ? "rejected"
            : action === "salon.suspend"
              ? "suspended"
              : null;
    if (kind) notifyOwner(salon, kind, reason, input.reasonCode);
  }

  return result;
};

/**
 * Cancels every upcoming booking as if the salon had: the whole deposit back
 * plus the goodwill credit, and the customer emails. One transaction per
 * booking, so one that changed meanwhile (409) does not undo the rest.
 */
const cancelUpcoming = async (admin: AdminContext, ctx: AuditCtx | undefined, id: string, reason: string) => {
  await loadSalon(admin, id);
  const upcoming = await prisma.appointment.findMany({ where: upcomingWhere(id), select: { id: true } });

  let cancelled = 0;
  let failed = 0;
  for (const booking of upcoming) {
    try {
      await AppointmentService.cancelForSalonByAdmin(booking.id, `Cancelled by SalonKhuji: ${reason}`);
      cancelled++;
    } catch (error) {
      failed++;
      console.error(`[admin] could not cancel booking ${booking.id}`, error);
    }
  }

  await audit(ctx, {
    action: "salon.cancel_upcoming",
    entityType: "salon",
    entityId: id,
    salonId: id,
    after: { cancelled, failed },
    reason,
  });

  return { cancelled, failed };
};

const updateLocation = async (
  admin: AdminContext,
  ctx: AuditCtx | undefined,
  id: string,
  input: { latitude: number; longitude: number; reason?: string },
) => {
  const salon = await loadSalon(admin, id);
  const result = await prisma.salon.update({
    where: { id },
    data: {
      latitude: input.latitude,
      longitude: input.longitude,
      locationAccuracy: "EXACT",
      locationUpdatedAt: new Date(),
    },
    select: { id: true, latitude: true, longitude: true, locationAccuracy: true, locationUpdatedAt: true },
  });
  scheduleReindex(id, "salon.location");

  await audit(ctx, {
    action: "salon.location",
    entityType: "salon",
    entityId: id,
    salonId: id,
    before: { latitude: salon.latitude, longitude: salon.longitude, locationAccuracy: salon.locationAccuracy },
    after: { latitude: result.latitude, longitude: result.longitude, locationAccuracy: result.locationAccuracy },
    reason: input.reason ?? null,
  });
  return result;
};

const updateListing = async (
  admin: AdminContext,
  ctx: AuditCtx | undefined,
  id: string,
  input: { name?: string; description?: string; phone?: string; reason?: string },
) => {
  const salon = await loadSalon(admin, id);
  const { reason, ...fields } = input;
  const result = await prisma.salon.update({
    where: { id },
    data: fields,
    select: { id: true, name: true, description: true, phone: true },
  });
  scheduleReindex(id, "salon.listing");

  const before = { name: salon.name, description: salon.description, phone: salon.phone };
  const changes = diff(before, result);
  await audit(ctx, {
    action: "salon.update",
    entityType: "salon",
    entityId: id,
    salonId: id,
    before: changes.before,
    after: changes.after,
    reason: reason ?? null,
  });
  return result;
};

const reindex = async (admin: AdminContext, ctx: AuditCtx | undefined, id: string) => {
  await loadSalon(admin, id);
  const outcome = await indexSalon(id, { force: true });
  if (outcome === "missing") throw new ApiError(StatusCodes.NOT_FOUND, "Salon not found");
  if (outcome === "unconfigured") {
    throw new ApiError(StatusCodes.SERVICE_UNAVAILABLE, "GEMINI_API_KEY is not configured - AI search is unavailable");
  }
  await audit(ctx, { action: "salon.reindex", entityType: "salon", entityId: id, salonId: id, after: { outcome } });
  return { outcome };
};

/** Soft delete. Refused while upcoming bookings exist: cancel those first. */
const deleteSalon = async (
  admin: AdminContext,
  ctx: AuditCtx | undefined,
  id: string,
  input: { reason: string; confirmName: string },
) => {
  const salon = await loadSalon(admin, id);
  if (input.confirmName.trim().toLowerCase() !== salon.name.trim().toLowerCase()) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "The name you typed does not match this salon");
  }
  const upcoming = await prisma.appointment.count({ where: upcomingWhere(id) });
  if (upcoming > 0) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      `This salon has ${upcoming} upcoming booking(s). Cancel them first, then delete.`,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.salon.update({
      where: { id },
      data: { isDeleted: true, statusChangedAt: new Date(), statusChangedById: admin.userId, statusReason: input.reason },
    });
    await auditTx(tx, ctx, {
      action: "salon.delete",
      entityType: "salon",
      entityId: id,
      salonId: id,
      before: { status: salon.status, isDeleted: false },
      after: { isDeleted: true },
      reason: input.reason,
    });
  });
  scheduleReindex(id, "salon.delete");
  return { id, isDeleted: true };
};

export const AdminSalonsService = {
  listSalons,
  getSalon,
  listServices,
  listTeam,
  listBookings,
  listReviews,
  getMoney,
  listActivity,
  getImpact,
  updateStatus,
  cancelUpcoming,
  updateLocation,
  updateListing,
  reindex,
  deleteSalon,
};
