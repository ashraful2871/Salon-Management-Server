import { AppointmentStatus, Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { AuditCtx, auditTx } from "../../utils/audit";
import { AccessUser, assertBookingPermission, assertSalonPermission } from "../../utils/salonAccess";
import { addDays, DAY_MS, dayStart, dhakaDay } from "../Analytics/analytics.days";

/**
 * Stylist working hours (a weekly pattern) and time off (dated absences).
 *
 * Shifts are Asia/Dhaka wall-clock "HH:mm" per weekday, like slots. A stylist
 * with no shift rows works whenever the salon is open - the behaviour before
 * shifts existed. Time off is a pair of instants and always wins.
 *
 * `isStaffWorking` is the one rule; every path that puts a stylist on a booking
 * calls it (assign, online booking with a chosen stylist, walk-in, reschedule).
 */

type Db = Prisma.TransactionClient | typeof prisma;
export type Interval = [number, number]; // minutes since midnight, [start, end)
export type ShiftRow = { weekday: number; startTime: string; endTime: string };
export type LeaveRow = { id?: string; startsAt: Date; endsAt: Date; reason?: string | null };

export const toMinutes = (hhmm: string | null | undefined) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

export const toHHmm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();

/** A day's shift intervals, or null when the stylist has no pattern at all. */
const shiftIntervals = (shifts: ShiftRow[], day: string): Interval[] | null => {
  if (shifts.length === 0) return null;
  const weekday = weekdayOf(day);
  return shifts
    .filter((s) => s.weekday === weekday)
    .map((s) => [toMinutes(s.startTime) ?? 0, toMinutes(s.endTime) ?? 0] as Interval)
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
};

/** The part of each absence that falls on `day`, in minutes. */
export const leaveIntervals = (leave: LeaveRow[], day: string): Array<Interval & { reason?: string | null }> => {
  const start = dayStart(day).getTime();
  const end = start + DAY_MS;
  const out: Array<Interval & { reason?: string | null }> = [];
  for (const l of leave) {
    const s = Math.max(l.startsAt.getTime(), start);
    const e = Math.min(l.endsAt.getTime(), end);
    if (s < e) {
      const range = [Math.floor((s - start) / 60000), Math.ceil((e - start) / 60000)] as Interval & {
        reason?: string | null;
      };
      range.reason = l.reason ?? null;
      out.push(range);
    }
  }
  return out;
};

const subtract = (base: Interval[], cuts: Interval[]): Interval[] =>
  cuts.reduce<Interval[]>(
    (acc, [cs, ce]) =>
      acc.flatMap(([s, e]): Interval[] => {
        if (ce <= s || cs >= e) return [[s, e]];
        return [
          ...(cs > s ? [[s, cs] as Interval] : []),
          ...(ce < e ? [[ce, e] as Interval] : []),
        ];
      }),
    base,
  );

/**
 * When the stylist can take work on `day`: their shifts (or `fallback`, the
 * salon's open hours, when they have no pattern) minus time off.
 */
export const workingIntervals = (shifts: ShiftRow[], leave: LeaveRow[], day: string, fallback: Interval[]) =>
  subtract(shiftIntervals(shifts, day) ?? fallback, leaveIntervals(leave, day));

export type WorkingCheck = { working: true } | { working: false; reason: "OFF_SHIFT" | "TIME_OFF" };

/** The rule, on rows already loaded. `date` is a calendar day (UTC midnight, as slots store it). */
export const checkWorking = (
  shifts: ShiftRow[],
  leave: LeaveRow[],
  date: Date,
  start: string,
  end?: string | null,
): WorkingCheck => {
  const day = date.toISOString().slice(0, 10);
  const s = toMinutes(start) ?? 0;
  const e = Math.max(toMinutes(end) ?? s, s + 1);

  const day0 = dayStart(day).getTime();
  const from = day0 + s * 60000;
  const to = day0 + e * 60000;
  if (leave.some((l) => l.startsAt.getTime() < to && l.endsAt.getTime() > from)) {
    return { working: false, reason: "TIME_OFF" };
  }

  const today = shiftIntervals(shifts, day);
  if (today && !today.some(([a, b]) => a <= s && e <= b)) return { working: false, reason: "OFF_SHIFT" };
  return { working: true };
};

const loadRules = async (db: Db, staffIds: string[], from: Date, to: Date) => {
  // Sequential: on a transaction client these share one connection.
  const shifts = await db.staffShift.findMany({
    where: { staffId: { in: staffIds } },
    select: { staffId: true, weekday: true, startTime: true, endTime: true },
  });
  const leave = await db.staffTimeOff.findMany({
    where: { staffId: { in: staffIds }, startsAt: { lt: to }, endsAt: { gt: from } },
    select: { id: true, staffId: true, startsAt: true, endsAt: true, reason: true },
    orderBy: { startsAt: "asc" },
  });
  const by = <T extends { staffId: string }>(rows: T[], id: string) => rows.filter((r) => r.staffId === id);
  return { shiftsOf: (id: string) => by(shifts, id), leaveOf: (id: string) => by(leave, id) };
};

/** True when the stylist works the whole of `start`–`end` on calendar day `date`. */
export const isStaffWorking = async (
  staffId: string,
  date: Date,
  start: string,
  end?: string | null,
  db: Db = prisma,
): Promise<WorkingCheck> => {
  const day = date.toISOString().slice(0, 10);
  const rules = await loadRules(db, [staffId], dayStart(day), dayStart(addDays(day, 1)));
  return checkWorking(rules.shiftsOf(staffId), rules.leaveOf(staffId), date, start, end);
};

/** 409 "{name} is off then" unless the stylist works that time. */
export const assertStaffWorking = async (
  staff: { id: string; name?: string | null },
  date: Date,
  start: string,
  end?: string | null,
  db: Db = prisma,
) => {
  const check = await isStaffWorking(staff.id, date, start, end, db);
  if (check.working) return;
  const name =
    staff.name ??
    (await db.staff.findUnique({ where: { id: staff.id }, select: { user: { select: { name: true } } } }))?.user
      .name ??
    "This stylist";
  throw new ApiError(StatusCodes.CONFLICT, `${name} is off then`);
};

/**
 * Calendar overlays per stylist: the gaps outside their shifts ("OFF") and
 * their time off ("LEAVE"), as wall-clock "YYYY-MM-DDTHH:mm" ranges.
 */
export const offRanges = async (staffIds: string[], days: string[], db: Db = prisma) => {
  const out = new Map<string, Array<{ start: string; end: string; kind: "OFF" | "LEAVE"; reason: string | null }>>();
  if (staffIds.length === 0 || days.length === 0) return out;
  const rules = await loadRules(db, staffIds, dayStart(days[0]), dayStart(addDays(days[days.length - 1], 1)));
  for (const id of staffIds) {
    const shifts = rules.shiftsOf(id);
    const leave = rules.leaveOf(id);
    const ranges: Array<{ start: string; end: string; kind: "OFF" | "LEAVE"; reason: string | null }> = [];
    for (const day of days) {
      const at = (min: number) => `${day}T${toHHmm(Math.min(min, 24 * 60))}`;
      const worked = shiftIntervals(shifts, day);
      if (worked) {
        for (const [s, e] of subtract([[0, 24 * 60]], worked)) ranges.push({ start: at(s), end: at(e), kind: "OFF", reason: null });
      }
      for (const l of leaveIntervals(leave, day)) {
        ranges.push({ start: at(l[0]), end: at(l[1]), kind: "LEAVE", reason: l.reason ?? null });
      }
    }
    out.set(id, ranges);
  }
  return out;
};

/** Who of the branch's stylists can take this booking - for the assign picker. */
const availabilityForAppointment = async (user: AccessUser, appointmentId: string) => {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { id: true, salonId: true, staffId: true, appointmentDate: true, startTime: true, endTime: true },
  });
  if (!appt) throw new ApiError(StatusCodes.NOT_FOUND, "Appointment not found");
  await assertBookingPermission(user, appt, "bookings.manage");

  const staff = await prisma.staff.findMany({
    where: { salonId: appt.salonId, isDeleted: false },
    select: { id: true },
  });
  const day = appt.appointmentDate.toISOString().slice(0, 10);
  const rules = await loadRules(
    prisma,
    staff.map((s) => s.id),
    dayStart(day),
    dayStart(addDays(day, 1)),
  );
  return staff.map((s) => {
    const check = checkWorking(rules.shiftsOf(s.id), rules.leaveOf(s.id), appt.appointmentDate, appt.startTime, appt.endTime);
    return { staffId: s.id, working: check.working, reason: check.working ? null : check.reason };
  });
};

// --- management (staff.manage: owner + manager) ---------------------------------

const loadStaff = async (user: AccessUser, staffId: string) => {
  const staff = await prisma.staff.findFirst({
    where: { id: staffId, isDeleted: false },
    select: { id: true, salonId: true, user: { select: { name: true } } },
  });
  if (!staff) throw new ApiError(StatusCodes.NOT_FOUND, "Staff not found");
  await assertSalonPermission(user, staff.salonId, "staff.manage");
  return staff;
};

const sortShifts = (rows: ShiftRow[]) =>
  [...rows].sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));

const getShifts = async (user: AccessUser, staffId: string) => {
  const staff = await loadStaff(user, staffId);
  const shifts = await prisma.staffShift.findMany({
    where: { staffId },
    select: { weekday: true, startTime: true, endTime: true },
  });
  return { staffId, name: staff.user.name, salonId: staff.salonId, shifts: sortShifts(shifts) };
};

/** Replaces the whole week. An empty list = works whenever the salon is open. */
const putShifts = async (user: AccessUser, ctx: AuditCtx, staffId: string, shifts: ShiftRow[]) => {
  const staff = await loadStaff(user, staffId);

  for (let d = 0; d < 7; d++) {
    const day = shifts
      .filter((s) => s.weekday === d)
      .map((s) => [toMinutes(s.startTime)!, toMinutes(s.endTime)!] as Interval)
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < day.length; i++) {
      if (day[i][0] < day[i - 1][1]) {
        throw new ApiError(StatusCodes.BAD_REQUEST, "Two shifts on the same day overlap.");
      }
    }
  }

  return prisma.$transaction(async (tx) => {
    const before = await tx.staffShift.findMany({
      where: { staffId },
      select: { weekday: true, startTime: true, endTime: true },
    });
    await tx.staffShift.deleteMany({ where: { staffId } });
    if (shifts.length) {
      await tx.staffShift.createMany({
        data: shifts.map((s) => ({ staffId, weekday: s.weekday, startTime: s.startTime, endTime: s.endTime })),
      });
    }
    await auditTx(tx, ctx, {
      action: "staff.shifts_update",
      entityType: "staff",
      entityId: staffId,
      salonId: staff.salonId,
      before: sortShifts(before),
      after: sortShifts(shifts),
    });
    return { staffId, name: staff.user.name, salonId: staff.salonId, shifts: sortShifts(shifts) };
  });
};

/** Current and future absences, plus the last 30 days. */
const listTimeOff = async (user: AccessUser, staffId: string) => {
  await loadStaff(user, staffId);
  return prisma.staffTimeOff.findMany({
    where: { staffId, endsAt: { gte: dayStart(addDays(dhakaDay(), -30)) } },
    select: { id: true, startsAt: true, endsAt: true, reason: true, createdAt: true },
    orderBy: { startsAt: "asc" },
    take: 100,
  });
};

const ACTIVE: AppointmentStatus[] = [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED];

/**
 * Adds an absence. Bookings already made with the stylist in that window are
 * counted and returned, never moved or cancelled - the desk reassigns them.
 */
const addTimeOff = async (
  user: AccessUser,
  ctx: AuditCtx,
  staffId: string,
  body: { startsAt: string; endsAt: string; reason?: string },
) => {
  const staff = await loadStaff(user, staffId);
  const startsAt = new Date(body.startsAt);
  const endsAt = new Date(body.endsAt);
  if (!(endsAt > startsAt)) throw new ApiError(StatusCodes.BAD_REQUEST, "Time off must end after it starts.");
  if (endsAt.getTime() - startsAt.getTime() > 366 * DAY_MS) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Time off can be at most a year at a time.");
  }

  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.staffTimeOff.create({
      data: { staffId, startsAt, endsAt, reason: body.reason?.trim() || null, createdById: user.userId },
      select: { id: true, startsAt: true, endsAt: true, reason: true, createdAt: true },
    });
    await auditTx(tx, ctx, {
      action: "staff.time_off_create",
      entityType: "staff",
      entityId: staffId,
      salonId: staff.salonId,
      after: created,
    });
    return created;
  });

  // Calendar days are stored as UTC midnight of the Dhaka date.
  const firstDay = dhakaDay(startsAt);
  const lastDay = dhakaDay(new Date(endsAt.getTime() - 1));
  const candidates = await prisma.appointment.findMany({
    where: {
      staffId,
      status: { in: ACTIVE },
      appointmentDate: { gte: new Date(`${firstDay}T00:00:00Z`), lte: new Date(`${lastDay}T00:00:00Z`) },
    },
    select: { appointmentDate: true, startTime: true, endTime: true },
  });
  const clashing = candidates.filter(
    (a) => !checkWorking([], [row], a.appointmentDate, a.startTime, a.endTime).working,
  ).length;

  return { ...row, clashingBookings: clashing };
};

const deleteTimeOff = async (user: AccessUser, ctx: AuditCtx, staffId: string, timeOffId: string) => {
  const staff = await loadStaff(user, staffId);
  const row = await prisma.staffTimeOff.findFirst({ where: { id: timeOffId, staffId } });
  if (!row) throw new ApiError(StatusCodes.NOT_FOUND, "Time off not found");
  await prisma.$transaction(async (tx) => {
    await tx.staffTimeOff.delete({ where: { id: row.id } });
    await auditTx(tx, ctx, {
      action: "staff.time_off_delete",
      entityType: "staff",
      entityId: staffId,
      salonId: staff.salonId,
      before: row,
    });
  });
  return { id: row.id };
};

export const StaffSchedule = {
  availabilityForAppointment,
  getShifts,
  putShifts,
  listTimeOff,
  addTimeOff,
  deleteTimeOff,
};
