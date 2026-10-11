import { AppointmentStatus, Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import config from "../../../../config";
import ApiError from "../../../Error/error";
import prisma from "../../../shared/prisma";
import { audit, AuditCtx } from "../../../utils/audit";
import { sendEmail } from "../../../utils/emailSender";
import { getBookingCancelledByAdminTemplate } from "../../../utils/emailTemplates";
import { formatBDT } from "../../../utils/money";
import { AppointmentService } from "../../Appointment/appointment.service";
import { toCalendarDate } from "../../Assistant/assistant.availability";
import type { AdminContext } from "../admin.middleware";
import { can } from "../admin.permissions";
import { parseListQuery } from "../admin.query";
import { maskEmail, maskPhone } from "../admin.service";
import { BOOKING_CANCEL_REASON_LABELS, BookingCancelReasonCode } from "./bookings.validation";

const DAY = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE = /^\+?[\d\s-]{4,}$/;

/** "YYYY-MM-DD" in Dhaka -> the instant that day starts. */
const dhakaStart = (ymd: string) => new Date(`${ymd}T00:00:00+06:00`);

const pageMeta = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / limit)),
});

const insensitive = (value: string) => ({ equals: value.trim(), mode: "insensitive" as const });

type ListQuery = Record<string, string | undefined>;

/** `TKN-a8f2` or `a8f2` -> `TKN-A8F2`, the way the counter lookup reads it. */
const normalizeToken = (raw: string) => {
  const upper = raw.trim().toUpperCase();
  return upper.startsWith("TKN-") ? upper : `TKN-${upper}`;
};

const searchWhere = (q: string): Prisma.AppointmentWhereInput => {
  if (/^TKN-/i.test(q)) return { token: { startsWith: normalizeToken(q) } };
  if (UUID.test(q)) return { id: q };
  if (q.includes("@")) return { customer: { email: { contains: q.toLowerCase(), mode: "insensitive" } } };
  if (PHONE.test(q)) return { customer: { phone: { contains: q.replace(/[\s-]/g, "").replace(/^\+/, "") } } };
  return {
    OR: [
      { customer: { name: { contains: q, mode: "insensitive" } } },
      { salon: { name: { contains: q, mode: "insensitive" } } },
    ],
  };
};

const listWhere = (query: ListQuery, q: string | undefined, withStatus: boolean) => {
  const and: Prisma.AppointmentWhereInput[] = [];

  // A token or id names one booking: find it even when it is test data.
  const exact = !!q && (/^TKN-/i.test(q) || UUID.test(q));
  if (query.includeTest !== "true" && !exact) and.push({ salon: { isTest: false }, customer: { isTest: false } });
  if (q) and.push(searchWhere(q));
  if (withStatus && query.status) and.push({ status: query.status as AppointmentStatus });
  if (query.salonId) and.push({ salonId: query.salonId });
  if (query.area) and.push({ salon: { area: insensitive(query.area) } });
  if (query.channel) and.push({ bookedVia: query.channel as Prisma.EnumBookingChannelFilter["equals"] });
  if (query.source) and.push({ source: query.source as Prisma.EnumAppointmentSourceFilter["equals"] });
  if (query.depositStatus) {
    and.push({ depositStatus: query.depositStatus as Prisma.EnumDepositStatusFilter["equals"] });
  }
  if (query.appealStatus) {
    and.push({ appealStatus: query.appealStatus as Prisma.EnumAppealStatusNullableFilter["equals"] });
  }
  if (query.from || query.to) {
    // appointmentDate is a calendar date stored at UTC midnight; createdAt is
    // an instant, so its day boundaries are Dhaka's.
    and.push(
      query.dateField === "createdAt"
        ? {
            createdAt: {
              ...(query.from ? { gte: dhakaStart(query.from) } : {}),
              ...(query.to ? { lt: new Date(dhakaStart(query.to).getTime() + DAY) } : {}),
            },
          }
        : {
            appointmentDate: {
              ...(query.from ? { gte: toCalendarDate(query.from) } : {}),
              ...(query.to ? { lte: toCalendarDate(query.to) } : {}),
            },
          },
    );
  }

  return { AND: and } satisfies Prisma.AppointmentWhereInput;
};

const listBookings = async (query: ListQuery) => {
  const dateField = query.dateField === "createdAt" ? "createdAt" : "appointmentDate";
  const { skip, take, orderBy, q, page, limit } = parseListQuery(query, {
    sortable: ["createdAt", "appointmentDate", "totalMinor"],
    defaultSort: { field: query.from || query.to ? dateField : "createdAt", order: "desc" },
  });
  const [field, order] = Object.entries(orderBy)[0];
  const sort: Prisma.AppointmentOrderByWithRelationInput[] =
    field === "appointmentDate"
      ? [{ appointmentDate: order }, { startTime: order }, { id: "asc" }]
      : [{ [field]: order }, { id: "asc" }];

  const where = listWhere(query, q, true);
  const [rows, total, byStatus] = await Promise.all([
    prisma.appointment.findMany({
      where,
      orderBy: sort,
      skip,
      take,
      select: {
        id: true,
        token: true,
        serialNumber: true,
        status: true,
        appointmentDate: true,
        startTime: true,
        endTime: true,
        totalMinor: true,
        depositMinor: true,
        depositStatus: true,
        bookedVia: true,
        source: true,
        appealStatus: true,
        cancelledBy: true,
        createdAt: true,
        customer: { select: { id: true, name: true, email: true, isTest: true } },
        salon: { select: { id: true, name: true, area: true, isTest: true } },
        service: { select: { id: true, name: true } },
      },
    }),
    prisma.appointment.count({ where }),
    prisma.appointment.groupBy({ by: ["status"], where: listWhere(query, q, false), _count: { _all: true } }),
  ]);

  return {
    meta: {
      ...pageMeta(page, limit, total),
      statusCounts: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
    },
    // Lists always mask; the full contact is on the booking page with users.view_pii.
    data: rows.map(({ customer, ...b }) => ({
      ...b,
      customer: { ...customer, email: maskEmail(customer.email) },
    })),
  };
};

// ---------------------------------------------------------------- detail

type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "info";

export type TimelineEvent = {
  at: Date;
  kind: string;
  title: string;
  detail?: string | null;
  tone?: Tone;
  actor?: string | null;
  amountMinor?: number;
};

const CHANNEL_LABELS: Record<string, string> = {
  WEB: "on the website",
  ASSISTANT: "through the chat assistant",
  WALK_IN: "as a walk-in at the counter",
};

const WALLET_EVENTS: Record<string, { title: string; tone: Tone }> = {
  DEPOSIT_HOLD: { title: "Deposit held", tone: "info" },
  DEPOSIT_RELEASE: { title: "Deposit released", tone: "success" },
  DEPOSIT_APPLIED: { title: "Deposit applied to the bill", tone: "success" },
  DEPOSIT_FORFEIT: { title: "Deposit forfeited", tone: "danger" },
  REFUND: { title: "Refund to wallet", tone: "success" },
  GOODWILL_CREDIT: { title: "Goodwill credit", tone: "success" },
  ADJUSTMENT: { title: "Wallet adjustment", tone: "warning" },
};

const CANCELLED_BY_LABELS: Record<string, string> = {
  CUSTOMER: "the customer",
  SALON: "the salon",
  ADMIN: "an admin",
  SYSTEM: "the system",
};

const AUDIT_TITLES: Record<string, string> = {
  "booking.status_change": "Status changed by an admin",
  "booking.check_in": "Checked in by an admin",
  "booking.start": "Started by an admin",
  "booking.checkout": "Checked out by an admin",
  "payment.create": "Payment recorded by an admin",
  "payment.status_change": "Payment status changed by an admin",
};

const actorNames = async (ids: (string | null | undefined)[]) => {
  const unique = [...new Set(ids.filter((a): a is string => !!a))];
  const actors = unique.length
    ? await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } })
    : [];
  return new Map(actors.map((a) => [a.id, a.name]));
};

const loadBooking = (id: string) =>
  prisma.appointment.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, name: true, email: true, phone: true, status: true, isTest: true } },
      salon: {
        select: {
          id: true,
          name: true,
          area: true,
          phone: true,
          status: true,
          isTest: true,
          owner: { select: { user: { select: { id: true, name: true, email: true, phone: true } } } },
        },
      },
      service: { select: { id: true, name: true, priceMinor: true } },
      staff: { select: { id: true, user: { select: { name: true } } } },
      counter: { select: { id: true, name: true } },
      payment: true,
      review: { select: { id: true, rating: true, comment: true, createdAt: true } },
      ledgerEntries: { orderBy: { createdAt: "asc" } },
    },
  });

type Booking = NonNullable<Awaited<ReturnType<typeof loadBooking>>>;

const ACCOUNT_LABELS: Record<string, string> = {
  CUSTOMER_WALLET: "Customer wallet",
  SALON_PAYABLE: "Salon payable",
  PLATFORM_REVENUE: "Platform revenue",
  GATEWAY_CLEARING: "Gateway clearing",
};

const buildTimeline = (
  b: Booking,
  walletTx: { id: string; type: string; amount: number; description: string; createdAt: Date }[],
  audits: { action: string; actorUserId: string | null; after: Prisma.JsonValue; reason: string | null; createdAt: Date }[],
  names: Map<string, string>,
): TimelineEvent[] => {
  const events: TimelineEvent[] = [];
  const name = (id: string | null | undefined) => (id ? (names.get(id) ?? "Unknown user") : null);

  events.push({
    at: b.createdAt,
    kind: "created",
    title: `Booked ${CHANNEL_LABELS[b.bookedVia] ?? ""}`.trim(),
    detail: `${b.customer.name} · ${b.service.name}`,
    tone: "primary",
  });

  for (const tx of walletTx) {
    const known = WALLET_EVENTS[tx.type] ?? { title: tx.type, tone: "neutral" as Tone };
    events.push({
      at: tx.createdAt,
      kind: "wallet",
      title: known.title,
      detail: tx.description,
      tone: known.tone,
      // Holds and releases move money between balance and held balance, so
      // their own amount is 0; the deposit is what moved.
      amountMinor: tx.amount !== 0 ? tx.amount : b.depositMinor,
    });
  }

  if (b.reminder24At) events.push({ at: b.reminder24At, kind: "reminder", title: "24-hour reminder sent", tone: "neutral" });
  if (b.reminder2hAt) events.push({ at: b.reminder2hAt, kind: "reminder", title: "2-hour reminder sent", tone: "neutral" });

  if (b.checkedInAt) {
    events.push({ at: b.checkedInAt, kind: "check_in", title: "Checked in", tone: "info", actor: name(b.checkedInById) });
  }
  if (b.startedAt) events.push({ at: b.startedAt, kind: "start", title: "Service started", tone: "info" });
  if (b.completedAt) {
    events.push({
      at: b.completedAt,
      kind: "complete",
      title: "Completed",
      detail: b.completedById ? null : "Closed by the stale-checkout job",
      tone: "success",
      actor: b.completedById ? name(b.completedById) : "System",
    });
  }

  const cancelAudit = audits.find((a) => a.action === "booking.cancel_admin");
  if (b.status === AppointmentStatus.CANCELLED || b.cancelledAt) {
    events.push({
      at: b.cancelledAt ?? b.updatedAt,
      kind: "cancel",
      title: b.cancelledBy ? `Cancelled by ${CANCELLED_BY_LABELS[b.cancelledBy]}` : "Cancelled (by unknown)",
      detail: b.cancellationReason,
      tone: "danger",
      actor: cancelAudit ? name(cancelAudit.actorUserId) : null,
    });
  }

  if (b.noShowMarkedAt) {
    events.push({ at: b.noShowMarkedAt, kind: "no_show", title: "Marked as a no-show", tone: "danger" });
  }
  if (b.appealedAt) {
    events.push({ at: b.appealedAt, kind: "appeal", title: "Customer appealed", detail: b.appealReason, tone: "warning" });
  }

  for (const a of audits) {
    if (a.action === "booking.cancel_admin") continue;
    const after = (a.after ?? {}) as Record<string, unknown>;
    if (a.action === "appeal.approve" || a.action === "appeal.reject") {
      const approve = a.action === "appeal.approve";
      events.push({
        at: a.createdAt,
        kind: "appeal_decision",
        title: approve ? (after.withoutAppeal ? "No-show reversed by an admin" : "Appeal upheld") : "Appeal rejected",
        detail: (typeof after.note === "string" && after.note) || a.reason,
        tone: approve ? "success" : "danger",
        actor: name(a.actorUserId),
      });
      continue;
    }
    events.push({
      at: a.createdAt,
      kind: "audit",
      title: AUDIT_TITLES[a.action] ?? a.action,
      detail: a.reason,
      tone: "neutral",
      actor: name(a.actorUserId),
    });
  }

  // Entries written together (one settlement) read as one event.
  const groups = new Map<number, Booking["ledgerEntries"]>();
  for (const e of b.ledgerEntries) {
    const key = e.createdAt.getTime();
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  for (const [at, entries] of groups) {
    events.push({
      at: new Date(at),
      kind: "ledger",
      title: `Ledger: ${entries[0].description}${entries.length > 1 ? ` (+${entries.length - 1})` : ""}`,
      detail: entries
        .map((e) => `${ACCOUNT_LABELS[e.account] ?? e.account} ${e.amountMinor >= 0 ? "+" : "−"}${formatBDT(Math.abs(e.amountMinor))}`)
        .join(" · "),
      tone: "neutral",
    });
  }

  if (b.review) {
    events.push({
      at: b.review.createdAt,
      kind: "review",
      title: `Reviewed ${b.review.rating}★`,
      detail: b.review.comment,
      tone: "primary",
    });
  }

  return events.sort((x, y) => x.at.getTime() - y.at.getTime());
};

const getBooking = async (admin: AdminContext, id: string) => {
  if (!UUID.test(id)) throw new ApiError(StatusCodes.NOT_FOUND, "Booking not found");
  const b = await loadBooking(id);
  if (!b) throw new ApiError(StatusCodes.NOT_FOUND, "Booking not found");

  const [walletTx, audits, customerNoShows, customerBookings] = await Promise.all([
    prisma.walletTransaction.findMany({
      where: { referenceType: "APPOINTMENT", referenceId: id },
      orderBy: { createdAt: "asc" },
      select: { id: true, type: true, amount: true, balanceAfter: true, heldAfter: true, description: true, createdAt: true },
    }),
    prisma.auditLog.findMany({
      where: { entityType: "booking", entityId: id },
      orderBy: { createdAt: "asc" },
      select: { action: true, actorUserId: true, after: true, reason: true, createdAt: true },
    }),
    prisma.appointment.count({ where: { customerId: b.customerId, status: AppointmentStatus.NO_SHOW } }),
    prisma.appointment.count({ where: { customerId: b.customerId } }),
  ]);
  const names = await actorNames([b.checkedInById, b.completedById, ...audits.map((a) => a.actorUserId)]);

  const pii = can(admin, "users.view_pii");
  const owner = b.salon.owner?.user ?? null;
  const ledgerSum = b.ledgerEntries.reduce((sum, e) => sum + e.amountMinor, 0);

  const { customer, salon, ledgerEntries, payment, review, ...booking } = b;

  return {
    ...booking,
    review,
    customer: {
      ...customer,
      email: pii ? customer.email : maskEmail(customer.email),
      phone: pii ? customer.phone : maskPhone(customer.phone),
      noShows: customerNoShows,
      bookings: customerBookings,
    },
    salon: {
      id: salon.id,
      name: salon.name,
      area: salon.area,
      status: salon.status,
      isTest: salon.isTest,
      phone: pii ? salon.phone : maskPhone(salon.phone),
      owner: owner
        ? {
            id: owner.id,
            name: owner.name,
            email: pii ? owner.email : maskEmail(owner.email),
            phone: pii ? owner.phone : maskPhone(owner.phone),
          }
        : null,
    },
    timeline: buildTimeline(b, walletTx, audits, names),
    money: {
      deposit: { amountMinor: b.depositMinor, status: b.depositStatus },
      payment,
      walletTx: walletTx.map(({ amount, ...tx }) => ({ ...tx, amountMinor: amount })),
      ledger: ledgerEntries.map((e) => ({
        id: e.id,
        account: e.account,
        amountMinor: e.amountMinor,
        description: e.description,
        payoutId: e.payoutId,
        createdAt: e.createdAt,
      })),
      ledgerSumMinor: ledgerSum,
      balanced: ledgerSum === 0,
    },
  };
};

// ---------------------------------------------------------------- actions

type CancelInput = { reasonCode: BookingCancelReasonCode; note?: string; notify: boolean };

const cancelForCustomer = async (ctx: AuditCtx | undefined, id: string, input: CancelInput) => {
  const b = await loadBooking(id);
  if (!b) throw new ApiError(StatusCodes.NOT_FOUND, "Booking not found");
  if (b.status !== AppointmentStatus.PENDING && b.status !== AppointmentStatus.CONFIRMED) {
    throw new ApiError(StatusCodes.BAD_REQUEST, `A ${b.status.toLowerCase().replace("_", " ")} booking cannot be cancelled`);
  }

  const label = BOOKING_CANCEL_REASON_LABELS[input.reasonCode];
  const reason = input.note ? `${label}: ${input.note}` : label;

  // The customer-cancel path with the free window forced: the whole deposit
  // goes back, no penalty, no goodwill, cancelledBy = ADMIN.
  const cancelled = await AppointmentService.cancelByAdmin(id, `Cancelled by SalonKhuji: ${reason}`);

  await audit(ctx, {
    action: "booking.cancel_admin",
    entityType: "booking",
    entityId: id,
    salonId: b.salonId,
    before: { status: b.status, depositStatus: b.depositStatus },
    after: { status: cancelled.status, cancelledBy: cancelled.cancelledBy, reasonCode: input.reasonCode, notify: input.notify },
    reason,
  });

  if (input.notify) {
    const when = `${b.appointmentDate.toISOString().slice(0, 10)} at ${b.startTime}`;
    const common = {
      salonName: b.salon.name,
      serviceName: b.service.name,
      when,
      token: b.token,
      reason,
      contactUrl: `${config.frontend_url}/contact`,
    };
    // sendEmail never throws; the catch keeps a mail problem from failing the cancel.
    void sendEmail(
      b.customer.email,
      "Your booking was cancelled",
      getBookingCancelledByAdminTemplate({
        ...common,
        audience: "customer",
        name: b.customer.name,
        refund: b.depositMinor > 0 ? formatBDT(b.depositMinor) : null,
      }),
    ).catch(() => undefined);
    const owner = b.salon.owner?.user;
    if (owner?.email) {
      void sendEmail(
        owner.email,
        `A booking at ${b.salon.name} was cancelled`,
        getBookingCancelledByAdminTemplate({ ...common, audience: "salon", name: owner.name, refund: null }),
      ).catch(() => undefined);
    }
  }

  return cancelled;
};

const reverseNoShow = async (admin: AdminContext, ctx: AuditCtx | undefined, id: string, reason: string) => {
  const before = await prisma.appointment.findUnique({
    where: { id },
    select: { salonId: true, appealStatus: true, depositStatus: true },
  });
  if (!before) throw new ApiError(StatusCodes.NOT_FOUND, "Booking not found");

  const updated = await AppointmentService.resolveAppeal(admin.userId, id, {
    approve: true,
    note: reason,
    // An appeal on file is decided the usual way; otherwise this reverses the
    // no-show anyway.
    withoutAppeal: before.appealStatus !== "PENDING",
  });

  await audit(ctx, {
    action: "appeal.approve",
    entityType: "booking",
    entityId: id,
    salonId: before.salonId,
    before: { appealStatus: before.appealStatus, depositStatus: before.depositStatus },
    after: {
      appealStatus: updated.appealStatus,
      depositStatus: updated.depositStatus,
      withoutAppeal: before.appealStatus !== "PENDING",
      note: reason,
    },
    reason,
  });

  return updated;
};

export const AdminBookingsService = { listBookings, getBooking, cancelForCustomer, reverseNoShow };
