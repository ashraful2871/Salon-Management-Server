import { Request, Response } from "express";
import { AppointmentStatus } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import catchAsync from "../../shared/catchAsync";
import prisma from "../../shared/prisma";
import sendResponse from "../../shared/sendResponse";
import { CsvColumn, streamCsv } from "../../utils/csv";
import { AccessUser, scopeSalonIds, withAccessCache } from "../../utils/salonAccess";
import { addDays, dateOnly, daysBetween, DAY_MS, dayStart, dhakaDay, isDay } from "../Analytics/analytics.days";
import { hoursFor } from "../Appointment/appointment.calendar";
import { Interval, toMinutes, workingIntervals } from "../Staff/staff.schedule";

/**
 * GET /owner/team/performance - per stylist, for the owner to pay their team.
 *
 * Bookings are counted by appointment date (Dhaka calendar day), cancelled
 * ones left out. Revenue = `totalMinor` of COMPLETED bookings, the same figure
 * as GMV. Utilisation = minutes of non-cancelled bookings / minutes on shift
 * (shifts minus time off; a stylist without shifts is on whenever the salon is
 * open). Bookings with no stylist are an "Unassigned" row per branch, so the
 * totals equal every booking in range.
 */

const MAX_DAYS = 366;

type Query = { salonId?: unknown; from?: unknown; to?: unknown };

const rangeOf = (q: Query) => {
  const today = dhakaDay();
  const from = q.from === undefined || q.from === "" ? `${today.slice(0, 8)}01` : q.from;
  const to = q.to === undefined || q.to === "" ? today : q.to;
  if (!isDay(from) || !isDay(to) || to < from) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "from and to must be days in YYYY-MM-DD format, from first.");
  }
  const days = daysBetween(from, to);
  if (days.length > MAX_DAYS) throw new ApiError(StatusCodes.BAD_REQUEST, "Pick at most a year.");
  return { from, to, days };
};

const minutesOf = (start: string, end: string | null, duration: number) => {
  const s = toMinutes(start) ?? 0;
  const e = toMinutes(end);
  return Math.max((e !== null && e > s ? e : s + (duration || 30)) - s, 0);
};

type Row = {
  staffId: string | null;
  name: string;
  salonId: string;
  salonName: string;
  bookings: number;
  completed: number;
  noShows: number;
  revenueMinor: number;
  avgTicketMinor: number;
  rating: number | null;
  reviews: number;
  bookedMinutes: number;
  availableMinutes: number | null;
  /** 0..1, null when there were no minutes on shift. */
  utilisation: number | null;
};

const getTeamPerformance = async (user: AccessUser, query: Query) => {
  const { from, to, days } = rangeOf(query);
  const salonIds =
    (await scopeSalonIds(user, "reports.view", typeof query.salonId === "string" ? query.salonId : undefined)) ?? [];
  if (!salonIds.length) return { from, to, rows: [] as Row[], totals: totalsOf([]) };

  const range = { gte: dateOnly(from), lt: new Date(dateOnly(to).getTime() + DAY_MS) };
  const [salons, staff, bookings] = await Promise.all([
    prisma.salon.findMany({ where: { id: { in: salonIds } }, select: { id: true, name: true, operatingHours: true } }),
    prisma.staff.findMany({
      where: { salonId: { in: salonIds }, isDeleted: false },
      select: { id: true, salonId: true, rating: true, totalReviews: true, user: { select: { name: true } } },
    }),
    prisma.appointment.findMany({
      where: { salonId: { in: salonIds }, appointmentDate: range, status: { not: AppointmentStatus.CANCELLED } },
      select: {
        salonId: true,
        staffId: true,
        status: true,
        totalMinor: true,
        startTime: true,
        endTime: true,
        service: { select: { duration: true } },
      },
    }),
  ]);

  // A stylist who left but served bookings in range still gets a line.
  const known = new Set(staff.map((s) => s.id));
  const gone = [...new Set(bookings.map((b) => b.staffId).filter((id): id is string => !!id && !known.has(id)))];
  const former = gone.length
    ? await prisma.staff.findMany({
        where: { id: { in: gone } },
        select: { id: true, salonId: true, rating: true, totalReviews: true, user: { select: { name: true } } },
      })
    : [];
  const everyone = [...staff, ...former];
  const ids = everyone.map((s) => s.id);

  const [shifts, leave] = await Promise.all([
    prisma.staffShift.findMany({
      where: { staffId: { in: ids } },
      select: { staffId: true, weekday: true, startTime: true, endTime: true },
    }),
    prisma.staffTimeOff.findMany({
      where: { staffId: { in: ids }, startsAt: { lt: dayStart(addDays(to, 1)) }, endsAt: { gt: dayStart(from) } },
      select: { staffId: true, startsAt: true, endsAt: true },
    }),
  ]);

  const salonById = new Map(salons.map((s) => [s.id, s]));
  const openBySalon = new Map(
    salons.map((s) => [
      s.id,
      new Map(
        hoursFor(s.operatingHours, days).map((h): [string, Interval[]] => {
          const open = toMinutes(h.open);
          const close = toMinutes(h.close);
          return [h.day, !h.closed && open !== null && close !== null && close > open ? [[open, close]] : []];
        }),
      ),
    ]),
  );

  const rows = new Map<string, Row>();
  const keyOf = (salonId: string, staffId: string | null) => `${salonId}:${staffId ?? "-"}`;

  for (const s of everyone) {
    const own = shifts.filter((x) => x.staffId === s.id);
    const off = leave.filter((x) => x.staffId === s.id);
    const open = openBySalon.get(s.salonId);
    const available = days.reduce(
      (sum, day) =>
        sum + workingIntervals(own, off, day, open?.get(day) ?? []).reduce((m, [a, b]) => m + (b - a), 0),
      0,
    );
    rows.set(keyOf(s.salonId, s.id), {
      staffId: s.id,
      name: s.user.name,
      salonId: s.salonId,
      salonName: salonById.get(s.salonId)?.name ?? "",
      bookings: 0,
      completed: 0,
      noShows: 0,
      revenueMinor: 0,
      avgTicketMinor: 0,
      rating: s.totalReviews > 0 ? Math.round(s.rating * 10) / 10 : null,
      reviews: s.totalReviews,
      bookedMinutes: 0,
      availableMinutes: available,
      utilisation: null,
    });
  }

  for (const b of bookings) {
    const key = keyOf(b.salonId, b.staffId);
    let row = rows.get(key);
    if (!row) {
      row = {
        staffId: null,
        name: "Unassigned",
        salonId: b.salonId,
        salonName: salonById.get(b.salonId)?.name ?? "",
        bookings: 0,
        completed: 0,
        noShows: 0,
        revenueMinor: 0,
        avgTicketMinor: 0,
        rating: null,
        reviews: 0,
        bookedMinutes: 0,
        availableMinutes: null,
        utilisation: null,
      };
      rows.set(key, row);
    }
    row.bookings += 1;
    row.bookedMinutes += minutesOf(b.startTime, b.endTime, b.service.duration);
    if (b.status === AppointmentStatus.COMPLETED) {
      row.completed += 1;
      row.revenueMinor += b.totalMinor;
    }
    if (b.status === AppointmentStatus.NO_SHOW) row.noShows += 1;
  }

  const list = [...rows.values()].map(finish);
  list.sort(
    (a, b) =>
      a.salonName.localeCompare(b.salonName) ||
      Number(a.staffId === null) - Number(b.staffId === null) ||
      b.revenueMinor - a.revenueMinor ||
      a.name.localeCompare(b.name),
  );
  return { from, to, rows: list, totals: totalsOf(list) };
};

const finish = (row: Row): Row => ({
  ...row,
  avgTicketMinor: row.completed ? Math.round(row.revenueMinor / row.completed) : 0,
  utilisation: row.availableMinutes ? Math.round((row.bookedMinutes / row.availableMinutes) * 1000) / 1000 : null,
});

const totalsOf = (rows: Row[]) => {
  const sum = (pick: (r: Row) => number) => rows.reduce((n, r) => n + pick(r), 0);
  const revenueMinor = sum((r) => r.revenueMinor);
  const completed = sum((r) => r.completed);
  // Utilisation only over stylists with shift minutes; "Unassigned" has none.
  const staffed = rows.filter((r) => r.availableMinutes !== null);
  const availableMinutes = staffed.reduce((n, r) => n + (r.availableMinutes ?? 0), 0);
  const bookedOnShift = staffed.reduce((n, r) => n + r.bookedMinutes, 0);
  return {
    bookings: sum((r) => r.bookings),
    completed,
    noShows: sum((r) => r.noShows),
    revenueMinor,
    avgTicketMinor: completed ? Math.round(revenueMinor / completed) : 0,
    bookedMinutes: sum((r) => r.bookedMinutes),
    availableMinutes,
    utilisation: availableMinutes ? Math.round((bookedOnShift / availableMinutes) * 1000) / 1000 : null,
  };
};

const performance = catchAsync(async (req: Request, res: Response) => {
  const data = await getTeamPerformance(withAccessCache(req), req.query);
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Team performance", data });
});

/** GET /owner/team/performance.csv - the same rows plus a total line ("payroll report"). */
const performanceCsv = catchAsync(async (req: Request, res: Response) => {
  const data = await getTeamPerformance(withAccessCache(req), req.query);
  type Line = Omit<Row, "staffId" | "rating" | "reviews" | "salonId"> & { rating: number | null };
  const columns: CsvColumn<Line>[] = [
    { header: "branch", value: (r) => r.salonName },
    { header: "stylist", value: (r) => r.name },
    { header: "bookings", value: (r) => r.bookings },
    { header: "completed", value: (r) => r.completed },
    { header: "no_shows", value: (r) => r.noShows },
    { header: "revenue_taka", value: (r) => r.revenueMinor, money: true },
    { header: "avg_ticket_taka", value: (r) => r.avgTicketMinor, money: true },
    { header: "rating", value: (r) => r.rating },
    { header: "booked_minutes", value: (r) => r.bookedMinutes },
    { header: "shift_minutes", value: (r) => r.availableMinutes },
    { header: "utilisation_percent", value: (r) => (r.utilisation === null ? null : Math.round(r.utilisation * 1000) / 10) },
  ];
  const lines: Line[] = [
    ...data.rows,
    { ...data.totals, name: "Total", salonName: "", rating: null },
  ];
  await streamCsv(res, {
    filename: `team-performance-${data.from}-to-${data.to}.csv`,
    columns,
    // Names of the owner's own team; no customer data.
    showPii: true,
    fetchBatch: async (after, take) => {
      const start = after ? lines.indexOf(after) + 1 : 0;
      return lines.slice(start, start + take);
    },
  });
});

export const OwnerTeam = { getTeamPerformance, performance, performanceCsv };
