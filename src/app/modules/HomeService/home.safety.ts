import { HomeBookingStatus, HomeReportStatus, HomeSafetyKind, Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import config from "../../../config";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { AuditCtx, auditTx } from "../../utils/audit";
import { AdminSupportService } from "../Admin/support/support.service";
import type { Actor } from "./home.booking";
import type { AdminReportStatusBody, SafetyReportBody } from "./home.validation";

/**
 * Safety on a home visit: either side can report a problem with a visit, the
 * customer can ask for help while the visit is under way (an URGENT support
 * ticket plus the support phone), and the back office works the reports
 * (homeservice.manage), optionally barring the customer from home visits.
 */

const MIN_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MIN_MS;
const PAGE_SIZE = 20;
/** Per reporter per visit: enough to add to a report, not enough to flood the queue. */
const MAX_REPORTS = 3;
/** Repeated Help taps inside this window return the same ticket. */
const HELP_REUSE_MS = 15 * MIN_MS;

const fail = (status: number, message: string, code: string) => ApiError.withCode(status, message, code);
const notFound = () => new ApiError(StatusCodes.NOT_FOUND, "Booking not found");
const readOnly = () =>
  fail(StatusCodes.FORBIDDEN, "Read-only view: changes are not allowed while viewing as this user.", "IMPERSONATION_READ_ONLY");

/** A visit that never got paid for has nothing to report about. */
const REPORTABLE: HomeBookingStatus[] = [
  HomeBookingStatus.CONFIRMED,
  HomeBookingStatus.EN_ROUTE,
  HomeBookingStatus.ARRIVED,
  HomeBookingStatus.IN_PROGRESS,
  HomeBookingStatus.COMPLETED,
  HomeBookingStatus.CANCELLED,
  HomeBookingStatus.NO_SHOW,
];
const UNDER_WAY: HomeBookingStatus[] = [HomeBookingStatus.EN_ROUTE, HomeBookingStatus.ARRIVED, HomeBookingStatus.IN_PROGRESS];

const fileReport = async (
  booking: { id: string; status: HomeBookingStatus },
  reporterId: string,
  reporterRole: "CUSTOMER" | "EXPERT",
  body: SafetyReportBody,
) => {
  if (!REPORTABLE.includes(booking.status)) {
    throw fail(StatusCodes.CONFLICT, "This booking can't be reported.", "INVALID_STATE");
  }
  const count = await prisma.homeSafetyReport.count({ where: { bookingId: booking.id, reporterId } });
  if (count >= MAX_REPORTS) {
    throw fail(StatusCodes.TOO_MANY_REQUESTS, "You've already reported this visit. Our team will be in touch.", "TOO_MANY_REPORTS");
  }
  return prisma.homeSafetyReport.create({
    data: { bookingId: booking.id, reporterId, reporterRole, kind: body.kind, details: body.details },
    select: { id: true, kind: true, status: true, createdAt: true },
  });
};

/** POST /bookings/:id/report: the customer's own visit, else 404. */
export const customerReport = async (actor: Actor, id: string, body: SafetyReportBody) => {
  if (actor.impersonating) throw readOnly();
  const b = await prisma.homeBooking.findFirst({ where: { id, customerId: actor.userId }, select: { id: true, status: true } });
  if (!b) throw notFound();
  return fileReport(b, actor.userId, "CUSTOMER", body);
};

/** POST /jobs/:id/report: only the assigned expert, else 404. */
export const expertReport = async (userId: string, id: string, body: SafetyReportBody) => {
  const b = await prisma.homeBooking.findFirst({
    where: { id, expert: { staff: { userId } } },
    select: { id: true, status: true },
  });
  if (!b) throw new ApiError(StatusCodes.NOT_FOUND, "Job not found");
  return fileReport(b, userId, "EXPERT", body);
};

const dhaka = (d: Date) =>
  d.toLocaleString("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short" });

/**
 * POST /bookings/:id/help (EN_ROUTE … IN_PROGRESS): an URGENT support ticket
 * with everything support needs to act, a SAFETY report linked to it for the
 * home-service queue, and the number to call. Tapping again within 15 minutes
 * returns the same ticket.
 */
export const requestHelp = async (actor: Actor, id: string) => {
  if (actor.impersonating) throw readOnly();
  const b = await prisma.homeBooking.findFirst({
    where: { id, customerId: actor.userId },
    select: {
      id: true,
      code: true,
      status: true,
      startAt: true,
      area: true,
      contactPhone: true,
      customer: { select: { name: true, email: true } },
      salon: { select: { name: true, phone: true } },
      expert: { select: { staff: { select: { user: { select: { name: true, phone: true } } } } } },
    },
  });
  if (!b) throw notFound();
  const supportPhone = config.homeService.supportPhone;
  if (!UNDER_WAY.includes(b.status)) {
    throw fail(StatusCodes.CONFLICT, "Help is for a visit that's under way. For anything else, contact support.", "INVALID_STATE");
  }

  const recent = await prisma.homeSafetyReport.findFirst({
    where: {
      bookingId: b.id,
      reporterId: actor.userId,
      supportTicketId: { not: null },
      createdAt: { gt: new Date(Date.now() - HELP_REUSE_MS) },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, supportTicketId: true },
  });
  if (recent?.supportTicketId) {
    const t = await prisma.supportTicket.findUnique({ where: { id: recent.supportTicketId }, select: { number: true } });
    if (t) return { ticketNumber: t.number, supportPhone, reportId: recent.id, reused: true };
  }

  const expert = b.expert.staff.user;
  const body = [
    `Help requested by the customer during home visit ${b.code} (status ${b.status}).`,
    "",
    `Customer: ${b.customer.name} · ${b.contactPhone} · ${b.customer.email}`,
    `Expert: ${expert.name}${expert.phone ? ` · ${expert.phone}` : ""}`,
    `Salon: ${b.salon.name}${b.salon.phone ? ` · ${b.salon.phone}` : ""}`,
    `Area: ${b.area ?? "—"} · Start: ${dhaka(b.startAt)} (Asia/Dhaka)`,
    `Booking: ${config.frontend_url}/dashboard/admin/home-service/bookings/${b.id}`,
  ].join("\n");

  const out = await prisma.$transaction(async (tx) => {
    const ticket = await AdminSupportService.createTicket(
      {
        source: "DASHBOARD",
        name: b.customer.name,
        email: b.customer.email,
        userId: actor.userId,
        subject: `Home visit ${b.code} — help`,
        category: "BOOKING",
        priority: "URGENT",
        body,
      },
      tx,
    );
    const report = await tx.homeSafetyReport.create({
      data: {
        bookingId: b.id,
        reporterId: actor.userId,
        reporterRole: "CUSTOMER",
        kind: HomeSafetyKind.SAFETY,
        details: "Help requested during the visit",
        supportTicketId: ticket.id,
      },
      select: { id: true },
    });
    return { ticketNumber: ticket.number, reportId: report.id };
  });
  console.warn(`[home] help requested on ${b.code}: ticket #${out.ticketNumber}`);
  return { ...out, supportPhone, reused: false };
};

// ---------------------------------------------------------------------------
// Back office: GET /admin/home-service/reports, POST …/:id/status
// ---------------------------------------------------------------------------

const REPORT_SELECT = {
  id: true,
  reporterId: true,
  reporterRole: true,
  kind: true,
  details: true,
  status: true,
  handledById: true,
  handledAt: true,
  handlerNote: true,
  supportTicketId: true,
  createdAt: true,
  booking: {
    select: {
      id: true,
      code: true,
      status: true,
      audience: true,
      startAt: true,
      area: true,
      customerId: true,
      salon: { select: { id: true, name: true } },
      customer: { select: { id: true, name: true } },
      expert: { select: { id: true, staff: { select: { user: { select: { name: true } } } } } },
    },
  },
} satisfies Prisma.HomeSafetyReportSelect;

type ReportRow = Prisma.HomeSafetyReportGetPayload<{ select: typeof REPORT_SELECT }>;

const reportView = (r: ReportRow, tickets: Map<string, number>, blocks: Map<string, Date>) => {
  const { booking, ...rest } = r;
  return {
    ...rest,
    ticketNumber: r.supportTicketId ? (tickets.get(r.supportTicketId) ?? null) : null,
    booking: {
      id: booking.id,
      code: booking.code,
      status: booking.status,
      audience: booking.audience,
      startAt: booking.startAt,
      area: booking.area,
      salon: booking.salon,
      customer: booking.customer,
      expert: { id: booking.expert.id, name: booking.expert.staff.user.name },
    },
    customerBlockedUntil: blocks.get(booking.customerId) ?? null,
  };
};

const withLookups = async (rows: ReportRow[]) => {
  const ticketIds = rows.flatMap((r) => (r.supportTicketId ? [r.supportTicketId] : []));
  const customerIds = [...new Set(rows.map((r) => r.booking.customerId))];
  const [tickets, blocks] = await Promise.all([
    ticketIds.length
      ? prisma.supportTicket.findMany({ where: { id: { in: ticketIds } }, select: { id: true, number: true } })
      : Promise.resolve([]),
    customerIds.length
      ? prisma.homeCustomerBlock.findMany({ where: { userId: { in: customerIds }, until: { gt: new Date() } }, select: { userId: true, until: true } })
      : Promise.resolve([]),
  ]);
  const t = new Map(tickets.map((x) => [x.id, x.number]));
  const bl = new Map(blocks.map((x) => [x.userId, x.until]));
  return rows.map((r) => reportView(r, t, bl));
};

/** Open ones first in, first out; the closed lists newest first. */
export const listReports = async (query: Record<string, unknown>) => {
  const status = (query.status as HomeReportStatus | undefined) ?? undefined;
  const page = Math.max(1, Math.min(10_000, Number(query.page) || 1));
  const where: Prisma.HomeSafetyReportWhereInput = status
    ? { status }
    : { status: { in: [HomeReportStatus.OPEN, HomeReportStatus.REVIEWING] } };
  const open = !status || status === HomeReportStatus.OPEN || status === HomeReportStatus.REVIEWING;
  const [total, rows, counts] = await Promise.all([
    prisma.homeSafetyReport.count({ where }),
    prisma.homeSafetyReport.findMany({
      where,
      orderBy: { createdAt: open ? "asc" : "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: REPORT_SELECT,
    }),
    prisma.homeSafetyReport.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  return {
    meta: {
      page,
      limit: PAGE_SIZE,
      total,
      totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      statusCounts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    },
    data: await withLookups(rows),
  };
};

/**
 * Moves a report (any status to any other: a dismissed one can be reopened)
 * with the admin's note; `blockCustomer` also bars the visit's customer from
 * home visits for `days` (a longer block already in place is kept). Audited.
 */
export const setReportStatus = async (ctx: AuditCtx | undefined, id: string, body: AdminReportStatusBody) => {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const r = await tx.homeSafetyReport.findUnique({
      where: { id },
      select: { id: true, status: true, handlerNote: true, booking: { select: { id: true, salonId: true, customerId: true } } },
    });
    if (!r) throw new ApiError(StatusCodes.NOT_FOUND, "Report not found");
    const n = await tx.homeSafetyReport.updateMany({
      where: { id, status: r.status },
      data: { status: body.status, handlerNote: body.note, handledById: ctx?.actorUserId ?? null, handledAt: now },
    });
    if (!n.count) throw fail(StatusCodes.CONFLICT, "This report changed meanwhile. Reload and try again.", "INVALID_STATE");

    let block: { until: Date; kept: boolean } | null = null;
    if (body.blockCustomer) {
      const userId = r.booking.customerId;
      const until = new Date(now.getTime() + body.blockCustomer.days * DAY_MS);
      const existing = await tx.homeCustomerBlock.findUnique({ where: { userId }, select: { until: true } });
      if (existing && existing.until >= until) {
        block = { until: existing.until, kept: true };
      } else {
        const reason = `Safety report: ${body.note}`.slice(0, 500);
        await tx.homeCustomerBlock.upsert({
          where: { userId },
          create: { userId, until, reason, source: "SAFETY", createdById: ctx?.actorUserId ?? null },
          update: { until, reason, source: "SAFETY", createdById: ctx?.actorUserId ?? null },
        });
        block = { until, kept: false };
      }
    }

    await auditTx(tx, ctx, {
      action: "homeService.safety_report_status",
      entityType: "HomeSafetyReport",
      entityId: id,
      salonId: r.booking.salonId,
      before: { status: r.status, handlerNote: r.handlerNote },
      after: {
        status: body.status,
        bookingId: r.booking.id,
        ...(block ? { customerBlockedUntil: block.until.toISOString(), existingBlockKept: block.kept } : {}),
      },
      reason: body.note,
    });
  });
  const row = await prisma.homeSafetyReport.findUniqueOrThrow({ where: { id }, select: REPORT_SELECT });
  return (await withLookups([row]))[0];
};
