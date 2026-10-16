import { AppointmentStatus, Prisma, SlotStatus } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { AuditCtx, auditTx } from "../../utils/audit";
import { AccessUser, assertSalonPermission } from "../../utils/salonAccess";
import { addDays, dhakaDay } from "../Analytics/analytics.days";

/**
 * Holidays and special hours. A closure is a Dhaka calendar day (stored as
 * UTC midnight, like `slot.date`), whole or a time range on it. Every booking
 * surface asks `isClosed` (or filters with `withoutClosed`), so a slot made
 * after the closure, or unblocked by hand, still cannot be booked inside it.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export type ClosureWindow = {
  salonId: string;
  date: Date;
  allDay: boolean;
  startTime: string | null;
  endTime: string | null;
};

type TimeRange = { salonId: string; date: Date; startTime: string; endTime: string };

const LIVE_BOOKING: AppointmentStatus[] = [
  AppointmentStatus.PENDING,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.CHECKED_IN,
];

const minutes = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + (m || 0);
};

/** "YYYY-MM-DD" (or a Date already at UTC midnight) → the stored calendar day. */
const calendarDay = (day: string | Date) =>
  typeof day === "string" ? new Date(`${day.slice(0, 10)}T00:00:00Z`) : day;

/** Whether a closure covers [startTime, endTime) on its day. Pure. */
export const closureCovers = (closure: ClosureWindow, startTime: string, endTime: string) => {
  if (closure.allDay || !closure.startTime || !closure.endTime) return true;
  const start = minutes(startTime);
  // A booking with no end time counts as its start minute.
  const end = Math.max(minutes(endTime), start + 1);
  return start < minutes(closure.endTime) && minutes(closure.startTime) < end;
};

const coveredBy = (closures: ClosureWindow[], row: TimeRange) =>
  closures.some(
    (c) =>
      c.salonId === row.salonId &&
      c.date.getTime() === row.date.getTime() &&
      closureCovers(c, row.startTime, row.endTime),
  );

const loadWindows = (salonIds: string[], dates: Date[], db: Db): Promise<ClosureWindow[]> =>
  salonIds.length && dates.length
    ? db.salonClosure.findMany({
        where: { salonId: { in: salonIds }, date: { in: dates } },
        select: { salonId: true, date: true, allDay: true, startTime: true, endTime: true },
      })
    : Promise.resolve([]);

/** The one availability question: is this salon closed for any of [start, end) that day? */
export const isClosed = async (
  salonId: string,
  date: string | Date,
  startTime: string,
  endTime: string,
  db: Db = prisma,
) => {
  const day = calendarDay(date);
  const windows = await loadWindows([salonId], [day], db);
  return coveredBy(windows, { salonId, date: day, startTime, endTime });
};

/** 409 `SALON_CLOSED` when the time falls in a closure. */
export const assertNotClosed = async (
  salonId: string,
  date: string | Date,
  startTime: string,
  endTime: string,
  db: Db = prisma,
) => {
  if (await isClosed(salonId, date, startTime, endTime, db)) {
    throw ApiError.withCode(StatusCodes.CONFLICT, "The salon is closed at that time", "SALON_CLOSED");
  }
};

/** Drops the rows that fall inside a closure, with one query for the whole list. */
export const withoutClosed = async <T extends TimeRange>(rows: T[], db: Db = prisma): Promise<T[]> => {
  if (!rows.length) return rows;
  const salonIds = [...new Set(rows.map((r) => r.salonId))];
  const dates = [...new Map(rows.map((r) => [r.date.getTime(), r.date])).values()];
  const windows = await loadWindows(salonIds, dates, db);
  return windows.length ? rows.filter((row) => !coveredBy(windows, row)) : rows;
};

// ---------------------------------------------------------------------------
// Owner CRUD (slots.manage)
// ---------------------------------------------------------------------------

const PUBLIC_SELECT = { id: true, date: true, allDay: true, startTime: true, endTime: true, reason: true } as const;

const serialize = <T extends { date: Date }>(row: T) => ({ ...row, date: row.date.toISOString().slice(0, 10) });

/** Upcoming closures for the public salon page (next 60 days, at most 10). */
export const upcomingClosures = async (salonId: string) => {
  const today = dhakaDay();
  const rows = await prisma.salonClosure.findMany({
    where: { salonId, date: { gte: calendarDay(today), lte: calendarDay(addDays(today, 60)) } },
    select: PUBLIC_SELECT,
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
    take: 10,
  });
  return rows.map(serialize);
};

const listClosures = async (user: AccessUser, salonId: string, query: { from?: string }) => {
  await assertSalonPermission(user, salonId, "slots.manage");
  const from = query.from ?? addDays(dhakaDay(), -30);
  const rows = await prisma.salonClosure.findMany({
    where: { salonId, date: { gte: calendarDay(from) } },
    select: { ...PUBLIC_SELECT, createdAt: true, blockedSlotIds: true },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
    take: 200,
  });
  return rows.map(({ blockedSlotIds, ...row }) => ({ ...serialize(row), blockedSlots: blockedSlotIds.length }));
};

type ClosureInput = { date: string; allDay?: boolean; startTime?: string; endTime?: string; reason: string };

const createClosure = async (user: AccessUser, ctx: AuditCtx, salonId: string, body: ClosureInput) => {
  await assertSalonPermission(user, salonId, "slots.manage");

  const allDay = body.allDay ?? !(body.startTime && body.endTime);
  const startTime = allDay ? null : body.startTime!;
  const endTime = allDay ? null : body.endTime!;
  if (!allDay && minutes(endTime!) <= minutes(startTime!)) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "The closure must end after it starts.");
  }
  const today = dhakaDay();
  if (body.date < today) throw new ApiError(StatusCodes.BAD_REQUEST, "Pick today or a later day.");
  if (body.date > addDays(today, 366)) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Closures can be set up to a year ahead.");
  }
  const date = calendarDay(body.date);
  const window: ClosureWindow = { salonId, date, allDay, startTime, endTime };

  const sameDay = await prisma.salonClosure.findMany({
    where: { salonId, date },
    select: { allDay: true, startTime: true, endTime: true },
  });
  if (sameDay.some((c) => c.allDay || allDay || closureCovers({ ...window, ...c } as ClosureWindow, startTime!, endTime!))) {
    throw new ApiError(StatusCodes.CONFLICT, "This overlaps a closure already set for that day.");
  }

  const closure = await prisma.$transaction(async (tx) => {
    const slots = await tx.slot.findMany({
      where: { salonId, date, status: SlotStatus.AVAILABLE, isBooked: false },
      select: { id: true, startTime: true, endTime: true },
    });
    const blocked = slots.filter((s) => closureCovers(window, s.startTime, s.endTime)).map((s) => s.id);
    if (blocked.length) {
      await tx.slot.updateMany({
        where: { id: { in: blocked }, status: SlotStatus.AVAILABLE, isBooked: false },
        data: { status: SlotStatus.BLOCKED },
      });
    }
    const created = await tx.salonClosure.create({
      data: {
        salonId,
        date,
        allDay,
        startTime,
        endTime,
        reason: body.reason.trim(),
        blockedSlotIds: blocked,
        createdById: user.userId,
      },
      select: PUBLIC_SELECT,
    });
    await auditTx(tx, ctx, {
      action: "salon.closure_create",
      entityType: "salon",
      entityId: salonId,
      salonId,
      after: { ...serialize(created), blockedSlots: blocked.length },
      reason: created.reason,
    });
    return { ...serialize(created), blockedSlots: blocked.length };
  });

  // Existing bookings are reported, never cancelled: the owner decides.
  const candidates = await prisma.appointment.findMany({
    where: { salonId, appointmentDate: date, status: { in: LIVE_BOOKING } },
    select: {
      id: true,
      startTime: true,
      endTime: true,
      status: true,
      serialNumber: true,
      customer: { select: { name: true, phone: true } },
      service: { select: { name: true } },
    },
    orderBy: { startTime: "asc" },
  });
  const bookings = candidates
    .filter((a) => closureCovers(window, a.startTime, a.endTime ?? a.startTime))
    .map((a) => ({
      id: a.id,
      startTime: a.startTime,
      endTime: a.endTime,
      status: a.status,
      serialNumber: a.serialNumber,
      customerName: a.customer?.name ?? null,
      customerPhone: a.customer?.phone ?? null,
      serviceName: a.service?.name ?? null,
    }));

  return {
    closure,
    bookings,
    notice: bookings.length
      ? `${bookings.length} booking${bookings.length === 1 ? "" : "s"} that ${allDay ? "day" : "time"}: contact or cancel them`
      : null,
  };
};

const deleteClosure = async (user: AccessUser, ctx: AuditCtx, salonId: string, closureId: string) => {
  await assertSalonPermission(user, salonId, "slots.manage");
  const row = await prisma.salonClosure.findFirst({ where: { id: closureId, salonId } });
  if (!row) throw new ApiError(StatusCodes.NOT_FOUND, "Closure not found");

  return prisma.$transaction(async (tx) => {
    await tx.salonClosure.delete({ where: { id: row.id } });
    // Reopen only what this closure blocked, still blocked, unbooked, and not
    // inside another closure that day.
    let reopened = 0;
    if (row.blockedSlotIds.length) {
      const slots = await tx.slot.findMany({
        where: { id: { in: row.blockedSlotIds }, status: SlotStatus.BLOCKED, isBooked: false },
        select: { id: true, salonId: true, date: true, startTime: true, endTime: true },
      });
      const open = await withoutClosed(slots, tx);
      if (open.length) {
        ({ count: reopened } = await tx.slot.updateMany({
          where: { id: { in: open.map((s) => s.id) }, status: SlotStatus.BLOCKED, isBooked: false },
          data: { status: SlotStatus.AVAILABLE },
        }));
      }
    }
    const { blockedSlotIds, ...before } = row;
    await auditTx(tx, ctx, {
      action: "salon.closure_delete",
      entityType: "salon",
      entityId: salonId,
      salonId,
      before: { ...serialize(before), blockedSlots: blockedSlotIds.length },
      after: { reopenedSlots: reopened },
    });
    return { id: row.id, reopenedSlots: reopened };
  });
};

export const SalonClosureService = { listClosures, createClosure, deleteClosure };
