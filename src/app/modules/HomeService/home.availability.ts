import { AppointmentStatus, ExpertVerification, HomeAudience, Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { getSetting } from "../../utils/settings";
import { addDays, DAY_MS, dayStart, dhakaDay } from "../Analytics/analytics.days";
import { hoursFor } from "../Appointment/appointment.calendar";
import { toMinutes, workingIntervals, Interval as MinuteRange } from "../Staff/staff.schedule";
import { ACTIVE_BOOKING_STATUSES } from "./home.expertSetup";

/**
 * When a verified expert can start a home visit. `computeSlots` is the rule
 * and is pure; the loaders below build its input from the database. The
 * public slot lists and the booking call (Phase 6) both go through it, so a
 * start time offered here is one the booking accepts.
 *
 * All times of day are Asia/Dhaka wall clock, like shifts and closures; the
 * step grid is anchored at Dhaka midnight.
 */

type Db = Prisma.TransactionClient | typeof prisma;
export type Interval = { from: Date; to: Date };

const MIN_MS = 60 * 1000;

export type SlotInput = {
  /** YYYY-MM-DD, Dhaka. */
  date: string;
  now: Date;
  /** Σ of the cart's durations. */
  durationMin: number;
  stepMin: number;
  /** The branch's travel buffer, before and after the visit. */
  bufferMin: number;
  minLeadMin: number;
  bookingWindowDays: number;
  /** Staff shift blocks that day (no shift pattern → the salon's open hours). */
  working: Interval[];
  /** Branch dayStart–dayEnd clamped to the platform bounds; the visit fits inside. */
  homeHours: Interval;
  /** Ladies: the latest allowed start. */
  lastStartAt?: Date | null;
  /** Other active home bookings as [blockFrom, blockTo) + the staff's salon appointments. */
  busy: Interval[];
  /** Time off + closures. */
  closed: Interval[];
  jobsThatDay: number;
  maxJobsPerDay: number;
};

/** Offered start times, ascending. */
export const computeSlots = (i: SlotInput): Date[] => {
  const today = dhakaDay(i.now);
  if (i.date < today || i.date > addDays(today, i.bookingWindowDays - 1)) return [];
  if (i.jobsThatDay >= i.maxJobsPerDay || i.durationMin <= 0 || i.stepMin <= 0) return [];

  const day0 = dayStart(i.date).getTime();
  const step = i.stepMin * MIN_MS;
  const dur = i.durationMin * MIN_MS;
  const buf = i.bufferMin * MIN_MS;
  const earliest = i.now.getTime() + i.minLeadMin * MIN_MS;
  const lastStart = i.lastStartAt ? i.lastStartAt.getTime() : Infinity;
  const blocked = [...i.busy, ...i.closed].map((b) => [b.from.getTime(), b.to.getTime()] as const);

  const out = new Set<number>();
  for (const w of i.working) {
    const from = Math.max(w.from.getTime(), i.homeHours.from.getTime(), day0);
    const to = Math.min(w.to.getTime(), i.homeHours.to.getTime(), day0 + DAY_MS);
    for (let s = day0 + Math.ceil((from - day0) / step) * step; s + dur <= to && s <= lastStart; s += step) {
      if (s < earliest) continue;
      const a = s - buf;
      const b = s + dur + buf;
      if (blocked.some(([bf, bt]) => bf < b && bt > a)) continue;
      out.add(s);
    }
  }
  return [...out].sort((x, y) => x - y).map((t) => new Date(t));
};

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const minuteOfDhakaDay = (at: Date) => Math.floor((at.getTime() - dayStart(dhakaDay(at)).getTime()) / MIN_MS);

/** "9:30 AM", Dhaka. */
export const slotLabel = (at: Date) => {
  const m = minuteOfDhakaDay(at);
  const h = Math.floor(m / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

export const slotPeriod = (at: Date): "MORNING" | "AFTERNOON" | "EVENING" => {
  const m = minuteOfDhakaDay(at);
  return m < 12 * 60 ? "MORNING" : m < 17 * 60 ? "AFTERNOON" : "EVENING";
};

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Today" | "Tomorrow" | "Thu 30". */
export const dayLabel = (day: string, today: string) =>
  day === today
    ? "Today"
    : day === addDays(today, 1)
      ? "Tomorrow"
      : `${WEEKDAY[new Date(`${day}T00:00:00Z`).getUTCDay()]} ${Number(day.slice(8, 10))}`;

// ---------------------------------------------------------------------------
// Settings, cart, eligibility
// ---------------------------------------------------------------------------

export const loadSlotSettings = async () => {
  const [stepMin, minLeadMin, bookingWindowDays, dayStartBound, dayEndBound, ladiesLastStart] = await Promise.all([
    getSetting("homeService.slotStepMinutes"),
    getSetting("homeService.minLeadMinutes"),
    getSetting("homeService.bookingWindowDays"),
    getSetting("homeService.dayStartBound"),
    getSetting("homeService.dayEndBound"),
    getSetting("homeService.ladiesLastStart"),
  ]);
  return { stepMin, minLeadMin, bookingWindowDays, dayStartBound, dayEndBound, ladiesLastStart };
};
export type SlotSettings = Awaited<ReturnType<typeof loadSlotSettings>>;

/** The bookable days, today first. */
export const windowDays = (settings: Pick<SlotSettings, "bookingWindowDays">, now = new Date()) =>
  Array.from({ length: settings.bookingWindowDays }, (_, n) => addDays(dhakaDay(now), n));

const invalidCart = (message: string) => ApiError.withCode(StatusCodes.BAD_REQUEST, message, "INVALID_CART");

/**
 * 1–10 distinct offerings, all active, one salon, one audience.
 * `INVALID_CART` / `AUDIENCE_MIXED` otherwise.
 */
export const loadCart = async (offeringIds: string[], db: Db = prisma) => {
  const ids = [...new Set(offeringIds)];
  if (ids.length < 1 || ids.length > 10) throw invalidCart("Pick between 1 and 10 services.");
  if (ids.length !== offeringIds.length) throw invalidCart("A service is in the cart twice.");

  const rows = await db.homeServiceOffering.findMany({
    where: { id: { in: ids }, isActive: true, isDeleted: false },
    select: { id: true, salonId: true, audience: true, category: true, name: true, durationMin: true, priceMinor: true },
  });
  if (rows.length !== ids.length) throw invalidCart("One of these services is no longer offered.");
  if (new Set(rows.map((r) => r.salonId)).size > 1) throw invalidCart("Pick services from one salon.");
  if (new Set(rows.map((r) => r.audience)).size > 1) {
    throw ApiError.withCode(StatusCodes.BAD_REQUEST, "Ladies and Gents services can't be booked together.", "AUDIENCE_MIXED");
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  const items = ids.map((id) => byId.get(id)!);
  return {
    salonId: rows[0].salonId,
    audience: rows[0].audience,
    items,
    durationMin: items.reduce((s, r) => s + r.durationMin, 0),
    subtotalMinor: items.reduce((s, r) => s + r.priceMinor, 0),
  };
};
export type Cart = Awaited<ReturnType<typeof loadCart>>;

/** Verified, active, not removed, staff not deleted, the right side, linked to every offering. */
export const eligibleExpertWhere = (audience: HomeAudience, offeringIds: string[] = []): Prisma.HomeExpertWhereInput => ({
  audience,
  verification: ExpertVerification.VERIFIED,
  isActive: true,
  removedAt: null,
  staff: { isDeleted: false },
  AND: offeringIds.map((offeringId) => ({ offerings: { some: { offeringId } } })),
});

export const eligibleExperts = (
  args: { salonId: string; audience: HomeAudience; offeringIds: string[] },
  db: Db = prisma,
) =>
  db.homeExpert.findMany({
    where: { salonId: args.salonId, ...eligibleExpertWhere(args.audience, args.offeringIds) },
    select: { id: true },
    orderBy: { rating: "desc" },
  });

// ---------------------------------------------------------------------------
// Loading a day
// ---------------------------------------------------------------------------

/** Everything `computeSlots` needs except the cart's duration. */
export type ExpertDay = Omit<SlotInput, "durationMin">;

const SALON_BUSY: AppointmentStatus[] = [
  AppointmentStatus.PENDING,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.CHECKED_IN,
  AppointmentStatus.IN_PROGRESS,
];

const at = (day0: number, min: number) => new Date(day0 + min * MIN_MS);

/**
 * One query per table for any number of experts and days.
 * Map: expertId → day → input. `excludeBookingId` leaves a booking out of
 * the busy list and the day's count (reschedule).
 */
export const loadExpertDays = async (
  expertIds: string[],
  days: string[],
  opts: { now?: Date; settings?: SlotSettings; excludeBookingId?: string; db?: Db } = {},
) => {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const out = new Map<string, Map<string, ExpertDay>>();
  if (!expertIds.length || !days.length) return out;
  const settings = opts.settings ?? (await loadSlotSettings());

  const sorted = [...days].sort();
  const rangeFrom = dayStart(sorted[0]);
  const rangeTo = dayStart(addDays(sorted[sorted.length - 1], 1));
  const calendarDates = sorted.map((d) => new Date(`${d}T00:00:00Z`));

  // Sequential: on a transaction client these share one connection.
  const experts = await db.homeExpert.findMany({
    where: { id: { in: expertIds } },
    select: {
      id: true,
      staffId: true,
      salonId: true,
      audience: true,
      maxJobsPerDay: true,
      salon: { select: { operatingHours: true, homeProfile: { select: { travelBufferMin: true, dayStart: true, dayEnd: true } } } },
    },
  });
  const staffIds = experts.map((e) => e.staffId);
  const salonIds = [...new Set(experts.map((e) => e.salonId))];

  const shifts = await db.staffShift.findMany({
    where: { staffId: { in: staffIds } },
    select: { staffId: true, weekday: true, startTime: true, endTime: true },
  });
  const leave = await db.staffTimeOff.findMany({
    where: { staffId: { in: staffIds }, startsAt: { lt: rangeTo }, endsAt: { gt: rangeFrom } },
    select: { staffId: true, startsAt: true, endsAt: true },
  });
  const closures = await db.salonClosure.findMany({
    where: { salonId: { in: salonIds }, date: { in: calendarDates } },
    select: { salonId: true, date: true, allDay: true, startTime: true, endTime: true },
  });
  const homeJobs = await db.homeBooking.findMany({
    where: {
      expertId: { in: expertIds },
      status: { in: ACTIVE_BOOKING_STATUSES },
      ...(opts.excludeBookingId ? { id: { not: opts.excludeBookingId } } : {}),
      OR: [{ blockFrom: { lt: rangeTo }, blockTo: { gt: rangeFrom } }, { serviceDate: { in: calendarDates } }],
    },
    select: { expertId: true, blockFrom: true, blockTo: true, serviceDate: true },
  });
  const appointments = await db.appointment.findMany({
    where: { staffId: { in: staffIds }, status: { in: SALON_BUSY }, appointmentDate: { in: calendarDates } },
    select: { staffId: true, appointmentDate: true, startTime: true, endTime: true },
  });

  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const startBound = toMinutes(settings.dayStartBound) ?? 0;
  const endBound = toMinutes(settings.dayEndBound) ?? 24 * 60;
  const ladiesLast = toMinutes(settings.ladiesLastStart);

  for (const e of experts) {
    const profile = e.salon.homeProfile;
    const own = shifts.filter((s) => s.staffId === e.staffId);
    const byDay = new Map<string, ExpertDay>();

    for (const day of sorted) {
      const day0 = dayStart(day).getTime();
      const homeFrom = Math.max(toMinutes(profile?.dayStart) ?? startBound, startBound);
      const homeTo = Math.min(toMinutes(profile?.dayEnd) ?? endBound, endBound);
      const homeHours = { from: at(day0, homeFrom), to: at(day0, Math.max(homeTo, homeFrom)) };

      // No shift pattern → the salon's open hours; no hours set at all → the home hours.
      const [hours] = hoursFor(e.salon.operatingHours, [day]);
      const open = toMinutes(hours.open);
      const close = toMinutes(hours.close);
      const fallback: MinuteRange[] =
        e.salon.operatingHours == null
          ? [[homeFrom, homeTo]]
          : !hours.closed && open !== null && close !== null && close > open
            ? [[open, close]]
            : [];
      const working = workingIntervals(own, [], day, fallback).map(([s, t]) => ({ from: at(day0, s), to: at(day0, t) }));

      const closed: Interval[] = [
        ...leave.filter((l) => l.staffId === e.staffId).map((l) => ({ from: l.startsAt, to: l.endsAt })),
        ...closures
          .filter((c) => c.salonId === e.salonId && dayKey(c.date) === day)
          .map((c) =>
            c.allDay || !c.startTime || !c.endTime
              ? { from: at(day0, 0), to: at(day0, 24 * 60) }
              : { from: at(day0, toMinutes(c.startTime) ?? 0), to: at(day0, toMinutes(c.endTime) ?? 24 * 60) },
          ),
      ];

      const jobs = homeJobs.filter((j) => j.expertId === e.id);
      const busy: Interval[] = [
        ...jobs.map((j) => ({ from: j.blockFrom, to: j.blockTo })),
        ...appointments
          .filter((a) => a.staffId === e.staffId && dayKey(a.appointmentDate) === day)
          .map((a) => {
            const s = toMinutes(a.startTime) ?? 0;
            let t = toMinutes(a.endTime) ?? s;
            if (t < s) t += 24 * 60; // runs past midnight
            return { from: at(day0, s), to: at(day0, Math.max(t, s + 1)) };
          }),
      ];

      byDay.set(day, {
        date: day,
        now,
        stepMin: settings.stepMin,
        bufferMin: profile?.travelBufferMin ?? 0,
        minLeadMin: settings.minLeadMin,
        bookingWindowDays: settings.bookingWindowDays,
        working,
        homeHours,
        lastStartAt: e.audience === HomeAudience.LADIES && ladiesLast !== null ? at(day0, ladiesLast) : null,
        busy,
        closed,
        jobsThatDay: jobs.filter((j) => dayKey(j.serviceDate) === day).length,
        maxJobsPerDay: e.maxJobsPerDay,
      });
    }
    out.set(e.id, byDay);
  }
  return out;
};

/** One expert, one day, one cart duration → the `computeSlots` input (null when the expert is gone). */
export const loadExpertDay = async (
  expertId: string,
  date: string,
  durationMin: number,
  opts: { now?: Date; excludeBookingId?: string; db?: Db } = {},
): Promise<SlotInput | null> => {
  const day = (await loadExpertDays([expertId], [date], opts)).get(expertId)?.get(date);
  return day ? { ...day, durationMin } : null;
};

// ---------------------------------------------------------------------------
// Availability for a cart
// ---------------------------------------------------------------------------

export type AvailableArgs = {
  /** One expert; omitted = any eligible expert of the cart's salon. */
  expertId?: string;
  offeringIds: string[];
  days: string[];
  now?: Date;
  excludeBookingId?: string;
  db?: Db;
};

const expertProblem = async (expertId: string, cart: Cart, db: Db) => {
  const expert = await db.homeExpert.findFirst({
    where: { id: expertId, ...eligibleExpertWhere(cart.audience) },
    select: { salonId: true },
  });
  return expert && expert.salonId === cart.salonId
    ? ApiError.withCode(StatusCodes.CONFLICT, "This expert doesn't do every service in your cart.", "EXPERT_CANNOT_DO_SERVICE")
    : ApiError.withCode(StatusCodes.NOT_FOUND, "This expert isn't available.", "EXPERT_UNAVAILABLE");
};

/**
 * Start times per day for a cart: day → [{ startAt, expertIds }]. Validates
 * the cart and, with `expertId`, that the expert can do all of it. Does not
 * check the branch is bookable or the address in range: callers do.
 */
export const availableFor = async (args: AvailableArgs) => {
  const db = args.db ?? prisma;
  const cart = await loadCart(args.offeringIds, db);
  const experts = await eligibleExperts({ salonId: cart.salonId, audience: cart.audience, offeringIds: cart.items.map((i) => i.id) }, db);
  let ids = experts.map((e) => e.id);
  if (args.expertId) {
    if (!ids.includes(args.expertId)) throw await expertProblem(args.expertId, cart, db);
    ids = [args.expertId];
  }

  const loaded = await loadExpertDays(ids, args.days, { now: args.now, excludeBookingId: args.excludeBookingId, db });
  const byDay = new Map<string, Array<{ startAt: Date; expertIds: string[] }>>();
  for (const day of args.days) {
    const union = new Map<number, string[]>();
    for (const id of ids) {
      const input = loaded.get(id)?.get(day);
      if (!input) continue;
      for (const s of computeSlots({ ...input, durationMin: cart.durationMin })) {
        const list = union.get(s.getTime()) ?? [];
        list.push(id);
        union.set(s.getTime(), list);
      }
    }
    byDay.set(
      day,
      [...union.entries()].sort(([a], [b]) => a - b).map(([t, expertIds]) => ({ startAt: new Date(t), expertIds })),
    );
  }
  return { cart, byDay };
};

/**
 * The booking-time check (Phase 6): is `startAt` an offered start for this
 * expert and cart right now? Throws the cart / expert errors of `availableFor`.
 */
export const expertCanTake = async (args: {
  expertId: string;
  offeringIds: string[];
  startAt: Date;
  now?: Date;
  excludeBookingId?: string;
  db?: Db;
}) => {
  const day = dhakaDay(args.startAt);
  const { cart, byDay } = await availableFor({ ...args, days: [day] });
  return { cart, ok: (byDay.get(day) ?? []).some((s) => s.startAt.getTime() === args.startAt.getTime()) };
};
