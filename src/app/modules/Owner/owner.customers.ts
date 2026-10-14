import { Request, Response } from "express";
import { AppointmentStatus, DepositStatus, Prisma, ReviewStatus, UserRole } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import ApiError from "../../Error/error";
import catchAsync from "../../shared/catchAsync";
import prisma from "../../shared/prisma";
import sendResponse from "../../shared/sendResponse";
import { audit, diff } from "../../utils/audit";
import { maskEmail } from "../../utils/otp";
import { AccessUser, assertOwnerOf, scopeSalonIds, withAccessCache } from "../../utils/salonAccess";
import { buildAuditCtx } from "../Admin/admin.middleware";
import { addDays, dateOnly, dhakaDay } from "../Analytics/analytics.days";

/**
 * Customer 360 for a business: everyone who booked at a branch in the
 * caller's `customers.view` scope. Notes and tags belong to the business
 * (SalonOwner) and are only ever read here - never on a customer-facing
 * response.
 *
 * Segments (Asia/Dhaka days, over bookings in scope):
 *   new     - first completed visit within the last 30 days
 *   regular - 3 or more completed visits
 *   lapsed  - has visited, and nothing (not cancelled) on or after 60 days ago
 *   noshow  - 2 or more no-shows
 */

export const SEGMENTS = ["new", "regular", "lapsed", "noshow"] as const;
type Segment = (typeof SEGMENTS)[number];
const NEW_DAYS = 30;
const LAPSED_DAYS = 60;
const REGULAR_VISITS = 3;
const NOSHOW_COUNT = 2;
const TIMELINE_LIMIT = 50;

const WALK_IN_EMAIL_DOMAIN = "@walk-in.invalid";

const listQuery = z.object({
  salonId: z.string().trim().min(1).optional(),
  segment: z.enum(SEGMENTS).optional(),
  search: z.string().trim().max(100).optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

export const customerNoteBody = z.object({
  body: z.object({
    note: z.string().trim().max(1000).nullable().optional(),
    tags: z
      .array(z.string().trim().toLowerCase().min(1).max(24))
      .max(10)
      .optional()
      .transform((tags) => (tags ? [...new Set(tags)] : tags)),
  }),
});
type NoteBody = z.infer<typeof customerNoteBody>["body"];

const parse = <T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> => {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(StatusCodes.BAD_REQUEST, result.error.issues[0]?.message ?? "Invalid query");
  }
  return result.data;
};

const notFound = () => new ApiError(StatusCodes.NOT_FOUND, "Customer not found");

const ok = (res: Response, message: string, data: unknown) =>
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message, data });

// ---------------------------------------------------------------- scope

type Scope = { ids: string[]; ownerId: string | null; isOwner: boolean };

/** Branches in scope plus the business they belong to (notes are per business). */
const scopeOf = async (user: AccessUser, salonId?: string): Promise<Scope> => {
  const ids = (await scopeSalonIds(user, "customers.view", salonId && salonId !== "all" ? salonId : undefined)) ?? [];
  const isOwner = user.role === UserRole.SALON_OWNER;
  if (isOwner) return { ids, ownerId: (await assertOwnerOf(user)).ownerId, isOwner };
  const salon = ids.length
    ? await prisma.salon.findFirst({ where: { id: { in: ids } }, select: { ownerId: true } })
    : null;
  return { ids, ownerId: salon?.ownerId ?? null, isOwner };
};

// ---------------------------------------------------------------- contact

const maskPhone = (phone: string) =>
  phone.length <= 6 ? "•".repeat(phone.length) : `${phone.slice(0, 2)}${"•".repeat(phone.length - 6)}${phone.slice(-4)}`;

/** Full for the owner, masked for everyone else; walk-in placeholders never. */
const contact = (row: { phone: string | null; email: string | null }, isOwner: boolean) => {
  const email = row.email && !row.email.endsWith(WALK_IN_EMAIL_DOMAIN) ? row.email : null;
  return {
    phone: row.phone ? (isOwner ? row.phone : maskPhone(row.phone)) : null,
    email: email ? (isOwner ? email : maskEmail(email)) : null,
    contactMasked: !isOwner,
  };
};

// ---------------------------------------------------------------- list

type AggRow = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  profilePhoto: string | null;
  visits: number;
  bookings: number;
  first_visit: Date | null;
  last_visit: Date | null;
  last_at: Date;
  spent: bigint;
  no_shows: number;
  tags: string[] | null;
};

const cutoffs = () => {
  const today = dhakaDay();
  return { newSince: dateOnly(addDays(today, -NEW_DAYS)), lapsedBefore: dateOnly(addDays(today, -LAPSED_DAYS)) };
};

const aggSql = (ids: string[]) => Prisma.sql`
  SELECT a."customerId" AS id,
    COUNT(*) FILTER (WHERE a.status = 'COMPLETED')::int AS visits,
    COUNT(*)::int AS bookings,
    MIN(a."appointmentDate") FILTER (WHERE a.status = 'COMPLETED') AS first_visit,
    MAX(a."appointmentDate") FILTER (WHERE a.status = 'COMPLETED') AS last_visit,
    MAX(a."appointmentDate") FILTER (WHERE a.status <> 'CANCELLED') AS last_active,
    MAX(a."appointmentDate") AS last_at,
    COALESCE(SUM(a."totalMinor") FILTER (WHERE a.status = 'COMPLETED'), 0)::bigint AS spent,
    COUNT(*) FILTER (WHERE a.status = 'NO_SHOW')::int AS no_shows
  FROM appointments a
  WHERE a."salonId" IN (${Prisma.join(ids)})
  GROUP BY a."customerId"`;

const segmentSql = (segment: Segment | undefined, c: ReturnType<typeof cutoffs>) => {
  switch (segment) {
    case "new":
      return Prisma.sql`AND agg.first_visit >= ${c.newSince}`;
    case "regular":
      return Prisma.sql`AND agg.visits >= ${REGULAR_VISITS}`;
    case "lapsed":
      return Prisma.sql`AND agg.visits > 0 AND agg.last_active < ${c.lapsedBefore}`;
    case "noshow":
      return Prisma.sql`AND agg.no_shows >= ${NOSHOW_COUNT}`;
    default:
      return Prisma.empty;
  }
};

/** Cursor = "<last booking ISO>_<customerId>", the list's sort key. */
const encodeCursor = (row: AggRow) => `${row.last_at.toISOString()}_${row.id}`;
const decodeCursor = (cursor: string) => {
  const at = cursor.indexOf("_");
  const when = new Date(cursor.slice(0, at));
  const id = cursor.slice(at + 1);
  if (at < 1 || Number.isNaN(when.getTime()) || !id) throw new ApiError(StatusCodes.BAD_REQUEST, "Invalid cursor");
  return { when, id };
};

const listCustomers = async (user: AccessUser, query: unknown) => {
  const q = parse(listQuery, query);
  const { ids, ownerId, isOwner } = await scopeOf(user, q.salonId);
  const empty = { items: [], nextCursor: null, counts: { all: 0, new: 0, regular: 0, lapsed: 0, noshow: 0 } };
  if (!ids.length) return empty;

  const c = cutoffs();
  const term = q.search ? `%${q.search.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  const searchSql = term
    ? Prisma.sql`AND (u.name ILIKE ${term} OR u.phone ILIKE ${term} OR (u.email ILIKE ${term} AND u.email NOT LIKE ${`%${WALK_IN_EMAIL_DOMAIN}`}))`
    : Prisma.empty;
  const after = q.cursor ? decodeCursor(q.cursor) : null;
  const cursorSql = after ? Prisma.sql`AND (agg.last_at, agg.id) < (${after.when}, ${after.id})` : Prisma.empty;

  const rows = await prisma.$queryRaw<AggRow[]>`
    WITH agg AS (${aggSql(ids)})
    SELECT agg.*, u.name, u.phone, u.email, u."profilePhoto", n.tags
    FROM agg
    JOIN users u ON u.id = agg.id
    LEFT JOIN customer_notes n ON n."ownerId" = ${ownerId ?? ""} AND n."customerId" = agg.id
    WHERE u."isDeleted" = false ${segmentSql(q.segment, c)} ${searchSql} ${cursorSql}
    ORDER BY agg.last_at DESC, agg.id DESC
    LIMIT ${q.limit + 1}`;

  // Chip counts on the first page only (they ignore search and segment).
  const counts = after
    ? null
    : (
        await prisma.$queryRaw<Array<Record<"all" | Segment, number>>>`
          WITH agg AS (${aggSql(ids)})
          SELECT COUNT(*)::int AS "all",
            COUNT(*) FILTER (WHERE agg.first_visit >= ${c.newSince})::int AS "new",
            COUNT(*) FILTER (WHERE agg.visits >= ${REGULAR_VISITS})::int AS "regular",
            COUNT(*) FILTER (WHERE agg.visits > 0 AND agg.last_active < ${c.lapsedBefore})::int AS "lapsed",
            COUNT(*) FILTER (WHERE agg.no_shows >= ${NOSHOW_COUNT})::int AS "noshow"
          FROM agg JOIN users u ON u.id = agg.id
          WHERE u."isDeleted" = false`
      )[0];

  const page = rows.slice(0, q.limit);
  return {
    items: page.map((row) => ({
      customerId: row.id,
      name: row.name,
      profilePhoto: row.profilePhoto,
      ...contact(row, isOwner),
      visits: row.visits,
      bookings: row.bookings,
      firstVisit: row.first_visit,
      lastVisit: row.last_visit,
      lastBookingAt: row.last_at,
      spentMinor: Number(row.spent),
      noShows: row.no_shows,
      tags: row.tags ?? [],
    })),
    nextCursor: rows.length > q.limit ? encodeCursor(page[page.length - 1]) : null,
    counts,
  };
};

// ---------------------------------------------------------------- detail

/** 404 unless the customer booked at a branch in scope. */
const assertCustomerInScope = async (ids: string[], customerId: string) => {
  if (!ids.length) throw notFound();
  const booking = await prisma.appointment.findFirst({
    where: { customerId, salonId: { in: ids }, customer: { isDeleted: false } },
    select: { id: true },
  });
  if (!booking) throw notFound();
};

const mostBookedService = async (where: Prisma.AppointmentWhereInput) => {
  const [top] = await prisma.appointment.groupBy({
    by: ["serviceId"],
    where,
    _count: { _all: true },
    orderBy: { _count: { serviceId: "desc" } },
    take: 1,
  });
  return top ? { id: top.serviceId, count: top._count._all } : null;
};

const mostBookedStylist = async (where: Prisma.AppointmentWhereInput) => {
  const [top] = await prisma.appointment.groupBy({
    by: ["staffId"],
    where: { ...where, staffId: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { staffId: "desc" } },
    take: 1,
  });
  return top?.staffId ? { id: top.staffId, count: top._count._all } : null;
};

const getCustomer = async (user: AccessUser, customerId: string, query: { salonId?: unknown }) => {
  const { ids, ownerId, isOwner } = await scopeOf(user, typeof query.salonId === "string" ? query.salonId : undefined);
  await assertCustomerInScope(ids, customerId);

  const inScope: Prisma.AppointmentWhereInput = { customerId, salonId: { in: ids } };
  const completed = { ...inScope, status: AppointmentStatus.COMPLETED };

  const [customer, timeline, byStatus, spend, forfeits, favService, favStaff, reviews, note] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: customerId },
      select: { id: true, name: true, phone: true, email: true, profilePhoto: true, createdAt: true },
    }),
    prisma.appointment.findMany({
      where: inScope,
      orderBy: [{ appointmentDate: "desc" }, { startTime: "desc" }],
      take: TIMELINE_LIMIT,
      select: {
        id: true,
        token: true,
        appointmentDate: true,
        startTime: true,
        status: true,
        totalMinor: true,
        depositMinor: true,
        depositStatus: true,
        bookedVia: true,
        salon: { select: { id: true, name: true } },
        service: { select: { id: true, name: true } },
        staff: { select: { id: true, user: { select: { name: true } } } },
        review: { select: { rating: true } },
      },
    }),
    prisma.appointment.groupBy({ by: ["status"], where: inScope, _count: { _all: true } }),
    prisma.appointment.aggregate({
      where: completed,
      _sum: { totalMinor: true },
      _min: { appointmentDate: true },
      _max: { appointmentDate: true },
    }),
    prisma.appointment.count({
      where: { ...inScope, depositStatus: { in: [DepositStatus.FORFEITED, DepositStatus.PARTIALLY_FORFEITED] } },
    }),
    mostBookedService(completed),
    mostBookedStylist(completed),
    prisma.review.findMany({
      where: { customerId, salonId: { in: ids } },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        rating: true,
        comment: true,
        status: true,
        hiddenReason: true,
        createdAt: true,
        ownerReply: true,
        ownerRepliedAt: true,
        salon: { select: { id: true, name: true } },
      },
    }),
    ownerId
      ? prisma.customerNote.findUnique({
          where: { ownerId_customerId: { ownerId, customerId } },
          select: { note: true, tags: true, updatedAt: true },
        })
      : null,
  ]);

  const [service, stylist] = await Promise.all([
    favService
      ? prisma.service.findUnique({ where: { id: favService.id }, select: { id: true, name: true } })
      : null,
    favStaff
      ? prisma.staff.findUnique({ where: { id: favStaff.id }, select: { id: true, user: { select: { name: true } } } })
      : null,
  ]);

  const count = (s: AppointmentStatus) => byStatus.find((row) => row.status === s)?._count._all ?? 0;

  return {
    customer: {
      customerId: customer.id,
      name: customer.name,
      profilePhoto: customer.profilePhoto,
      memberSince: customer.createdAt,
      ...contact(customer, isOwner),
    },
    stats: {
      bookings: byStatus.reduce((n, row) => n + row._count._all, 0),
      visits: count(AppointmentStatus.COMPLETED),
      cancelled: count(AppointmentStatus.CANCELLED),
      noShows: count(AppointmentStatus.NO_SHOW),
      forfeits,
      spentMinor: spend._sum.totalMinor ?? 0,
      firstVisit: spend._min.appointmentDate,
      lastVisit: spend._max.appointmentDate,
      favouriteService: service && favService ? { ...service, count: favService.count } : null,
      favouriteStylist:
        stylist && favStaff ? { id: stylist.id, name: stylist.user.name, count: favStaff.count } : null,
    },
    timeline: timeline.map(({ staff, review, ...row }) => ({
      ...row,
      staff: staff ? { id: staff.id, name: staff.user.name } : null,
      rating: review?.rating ?? null,
    })),
    reviews: reviews.map((r) => (r.status === ReviewStatus.HIDDEN ? { ...r, comment: null } : { ...r, hiddenReason: null })),
    note: { note: note?.note ?? null, tags: note?.tags ?? [], updatedAt: note?.updatedAt ?? null },
  };
};

// ---------------------------------------------------------------- note

const saveNote = async (req: Request, customerId: string, body: NoteBody) => {
  const user = withAccessCache(req);
  const { ids, ownerId } = await scopeOf(user);
  await assertCustomerInScope(ids, customerId);
  if (!ownerId) throw notFound();

  const where = { ownerId_customerId: { ownerId, customerId } };
  const existing = await prisma.customerNote.findUnique({ where, select: { note: true, tags: true } });
  const next = {
    note: body.note === undefined ? existing?.note ?? null : body.note || null,
    tags: body.tags ?? existing?.tags ?? [],
  };

  const saved = await prisma.customerNote.upsert({
    where,
    create: { ownerId, customerId, ...next, updatedById: user.userId },
    update: { ...next, updatedById: user.userId },
    select: { note: true, tags: true, updatedAt: true },
  });

  await audit(buildAuditCtx(req, user.role), {
    action: "customer.note",
    entityType: "customer",
    entityId: customerId,
    ...diff(existing, next),
  });
  return saved;
};

// ---------------------------------------------------------------- controllers

const list = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Customers", await listCustomers(withAccessCache(req), req.query));
});

const detail = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Customer", await getCustomer(withAccessCache(req), String(req.params.customerId), req.query));
});

const note = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Note saved", await saveNote(req, String(req.params.customerId), req.body));
});

export const OwnerCustomers = { list, detail, note };
