import { Request, Response } from "express";
import {
  AppointmentStatus,
  KycStatus,
  LocationAccuracy,
  PayoutAccountStatus,
  PayoutStatus,
  Prisma,
  ReviewStatus,
  SalonStatus,
  SlotStatus,
  UserRole,
} from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import prisma from "../../shared/prisma";
import sendResponse from "../../shared/sendResponse";
import { AccessUser, assertOwnerOf, scopeSalonIds, withAccessCache } from "../../utils/salonAccess";
import { addDays, dateOnly, dayStart, daySql, daysBetween, DAY_MS, dhakaDay } from "../Analytics/analytics.days";
import { attentionWhere } from "../Appointment/appointment.attention";
import { getOwnerBuckets } from "../Settlement/settlement.buckets";
import { getDailyMoney, getMoneyBySalon } from "../Settlement/settlement.earnings";

/**
 * GET /owner/home?salonId - what the owner should look at first, in one round
 * of parallel queries. Days are Asia/Dhaka; money comes from
 * settlement.earnings (contract 11), with the owner's own test data included.
 * "Week" is the last 7 days (today included) against the 7 before.
 */

const SETUP_ITEMS = ["services", "staff", "hours", "slots14d", "exactPin", "photos3", "payoutAccount", "kyc"] as const;
type SetupItem = (typeof SETUP_ITEMS)[number];
const MAX_LIST = 50;

const hasHours = (hours: unknown) => !!hours && typeof hours === "object" && Object.keys(hours).length > 0;
const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** "HH:mm" now in Dhaka - the clock salons book by. */
const dhakaClock = (now = new Date()) => new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString().slice(11, 16);

const getOwnerHome = async (user: AccessUser, query: { salonId?: unknown }) => {
  // Managers get the same page for their branches, without the money rows.
  const ownerId = user.role === UserRole.SALON_OWNER ? (await assertOwnerOf(user)).ownerId : null;
  const requested = typeof query.salonId === "string" && query.salonId && query.salonId !== "all" ? query.salonId : undefined;
  const ids = (await scopeSalonIds(user, "reports.view", requested)) ?? [];
  const isOwner = ownerId !== null;
  const inIds = { salonId: { in: ids } };

  const now = new Date();
  const today = dhakaDay(now);
  const todayDate = dateOnly(today);
  const days = daysBetween(addDays(today, -13), today); // 14: previous 7, then current 7
  const rangeDate = { gte: dateOnly(days[0]), lt: new Date(todayDate.getTime() + DAY_MS) };
  const next7 = { gte: todayDate, lt: new Date(todayDate.getTime() + 7 * DAY_MS) };
  const next14 = { gte: todayDate, lt: new Date(todayDate.getTime() + 14 * DAY_MS) };

  const [
    pendingConfirm,
    checkedInOver2h,
    unrecordedPayment,
    appealsOpen,
    unrepliedReviews,
    duesMinor,
    payoutFailed,
    verifiedAccounts,
    owner,
    salons,
    noSlots,
    byDayStatus,
    money,
    next,
    serviceCounts,
    staffCounts,
    slotCounts14,
    newCustomerRows,
    ratingRows,
    branchToday,
    branchMoney,
    openToday,
  ] = await Promise.all([
    prisma.appointment.count({ where: { ...inIds, ...attentionWhere("pending", now) } }),
    prisma.appointment.count({ where: { ...inIds, ...attentionWhere("stale", now) } }),
    prisma.appointment.count({ where: { ...inIds, ...attentionWhere("unrecorded", now) } }),
    prisma.appointment.count({ where: { ...inIds, ...attentionWhere("appeal", now) } }),
    prisma.review.count({ where: { ...inIds, status: ReviewStatus.PUBLISHED, ownerReply: null } }),
    ownerId ? getOwnerBuckets(ownerId).then((b) => b.duesMinor) : Promise.resolve(0),
    // FAILED since the last PAID payout: an older failure was already fixed.
    ownerId
      ? prisma.payout
          .findFirst({ where: { ownerId, status: PayoutStatus.PAID }, orderBy: { createdAt: "desc" }, select: { createdAt: true } })
          .then((last) =>
            prisma.payout.count({
              where: { ownerId, status: PayoutStatus.FAILED, ...(last && { createdAt: { gt: last.createdAt } }) },
            }),
          )
      : Promise.resolve(0),
    ownerId ? prisma.payoutAccount.count({ where: { ownerId, status: PayoutAccountStatus.VERIFIED } }) : 0,
    ownerId ? prisma.salonOwner.findUnique({ where: { id: ownerId }, select: { kycStatus: true } }) : null,
    prisma.salon.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, status: true, operatingHours: true, locationAccuracy: true, images: true, rating: true, totalReviews: true },
      orderBy: { name: "asc" },
    }),
    prisma.salon.findMany({
      where: {
        id: { in: ids },
        status: SalonStatus.ACTIVE,
        isDeleted: false,
        slots: { none: { status: SlotStatus.AVAILABLE, isBooked: false, date: next7 } },
      },
      select: { id: true },
    }),
    prisma.appointment.groupBy({
      by: ["appointmentDate", "status"],
      where: { ...inIds, appointmentDate: rangeDate },
      _count: true,
    }),
    getDailyMoney({ from: dayStart(days[0]), to: dayStart(addDays(today, 1)), includeTest: true, salonIds: ids }),
    prisma.appointment.findMany({
      where: {
        ...inIds,
        appointmentDate: todayDate,
        status: { in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED, AppointmentStatus.CHECKED_IN] },
        startTime: { gte: dhakaClock(now) },
      },
      orderBy: [{ startTime: "asc" }, { serialNumber: "asc" }],
      take: 3,
      select: {
        id: true,
        token: true,
        startTime: true,
        customer: { select: { name: true } },
        service: { select: { name: true } },
        staff: { select: { user: { select: { name: true } } } },
      },
    }),
    prisma.service.groupBy({ by: ["salonId"], where: { ...inIds, isDeleted: false, isActive: true }, _count: true }),
    prisma.staff.groupBy({ by: ["salonId"], where: { ...inIds, isDeleted: false }, _count: true }),
    prisma.slot.groupBy({
      by: ["salonId"],
      where: { ...inIds, status: SlotStatus.AVAILABLE, isBooked: false, date: next14 },
      _count: true,
    }),
    ids.length
      ? prisma.$queryRaw<Array<{ day: string; n: number }>>`
          SELECT to_char(first, 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
          FROM (
            SELECT "customerId", MIN("appointmentDate") AS first
            FROM appointments
            WHERE "salonId" IN (${Prisma.join(ids)}) AND status <> 'CANCELLED'
            GROUP BY 1
          ) t
          WHERE first >= ${dateOnly(days[0])} AND first <= ${todayDate}
          GROUP BY 1`
      : Promise.resolve([]),
    ids.length
      ? prisma.$queryRaw<Array<{ day: string; avg: number; n: number }>>`
          SELECT ${daySql(`"createdAt"`)} AS day, AVG(rating)::float AS avg, COUNT(*)::int AS n
          FROM reviews
          WHERE "salonId" IN (${Prisma.join(ids)}) AND status = ${ReviewStatus.PUBLISHED}::"ReviewStatus"
            AND "createdAt" >= ${dayStart(days[0])}
          GROUP BY 1`
      : Promise.resolve([]),
    prisma.appointment.groupBy({
      by: ["salonId", "status"],
      where: { ...inIds, appointmentDate: todayDate },
      _count: true,
    }),
    ids.length > 1
      ? getMoneyBySalon({ from: dayStart(today), to: dayStart(addDays(today, 1)), includeTest: true, salonIds: ids }, ids.length)
      : Promise.resolve([]),
    prisma.slot.groupBy({
      by: ["salonId"],
      where: { ...inIds, status: SlotStatus.AVAILABLE, isBooked: false, date: todayDate },
      _count: true,
    }),
  ]);

  // ---------------------------------------------------------------- today
  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const statusOn = (day: string, status: AppointmentStatus) =>
    byDayStatus.find((r) => dayKey(r.appointmentDate) === day && r.status === status)?._count ?? 0;
  const bookingsOn = (day: string) =>
    sum(byDayStatus.filter((r) => dayKey(r.appointmentDate) === day && r.status !== AppointmentStatus.CANCELLED).map((r) => r._count));
  const moneyOn = (day: string) => money.find((m) => m.day === day)?.gmvMinor ?? 0;

  const todayStrip = {
    bookings: bookingsOn(today),
    checkedIn: statusOn(today, AppointmentStatus.CHECKED_IN) + statusOn(today, AppointmentStatus.IN_PROGRESS),
    completed: statusOn(today, AppointmentStatus.COMPLETED),
    noShows: statusOn(today, AppointmentStatus.NO_SHOW),
    takingsMinor: moneyOn(today),
    next: next.map((b) => ({
      id: b.id,
      token: b.token,
      time: b.startTime,
      customerName: b.customer.name,
      serviceName: b.service.name,
      staffName: b.staff?.user.name ?? null,
    })),
  };

  // ---------------------------------------------------------------- setup
  const countOf = (rows: Array<{ salonId: string; _count: number }>) => new Map(rows.map((r) => [r.salonId, r._count]));
  const services = countOf(serviceCounts);
  const staff = countOf(staffCounts);
  const slots14 = countOf(slotCounts14);
  const payoutAccount = verifiedAccounts > 0;
  const kyc = owner?.kycStatus === KycStatus.VERIFIED;
  const setupRows = salons.map((s) => {
    const done: Record<SetupItem, boolean> = {
      services: (services.get(s.id) ?? 0) > 0,
      staff: (staff.get(s.id) ?? 0) > 0,
      hours: hasHours(s.operatingHours),
      slots14d: (slots14.get(s.id) ?? 0) > 0,
      exactPin: s.locationAccuracy === LocationAccuracy.EXACT,
      photos3: s.images.length >= 3,
      payoutAccount,
      kyc,
    };
    const n = SETUP_ITEMS.filter((k) => done[k]).length;
    return { salonId: s.id, salonName: s.name, percent: Math.round((n / SETUP_ITEMS.length) * 100), done };
  });
  const incomplete = setupRows.filter((r) => r.percent < 100).sort((a, b) => a.percent - b.percent);

  // ---------------------------------------------------------------- week
  const prevDays = days.slice(0, 7);
  const curDays = days.slice(7);
  const newOn = (day: string) => newCustomerRows.find((r) => r.day === day)?.n ?? 0;
  const noShowRateOn = (dayList: string[]) => {
    const ns = sum(dayList.map((d) => statusOn(d, AppointmentStatus.NO_SHOW)));
    const done = sum(dayList.map((d) => statusOn(d, AppointmentStatus.COMPLETED)));
    return pct(ns, ns + done);
  };
  const ratingOf = (dayList: string[]) => {
    const rows = ratingRows.filter((r) => dayList.includes(r.day));
    const n = sum(rows.map((r) => r.n));
    return n ? Math.round((sum(rows.map((r) => r.avg * r.n)) / n) * 10) / 10 : null;
  };
  const totals = (dayList: string[]) => ({
    revenueMinor: sum(dayList.map(moneyOn)),
    bookings: sum(dayList.map(bookingsOn)),
    newCustomers: sum(dayList.map(newOn)),
    noShowRate: noShowRateOn(dayList),
    rating: ratingOf(dayList),
  });
  const week = {
    days: curDays,
    current: totals(curDays),
    previous: totals(prevDays),
    // Plain arrays (no "Minor" key) so the envelope adds no taka twin to them.
    series: {
      revenue: curDays.map(moneyOn),
      bookings: curDays.map(bookingsOn),
      newCustomers: curDays.map(newOn),
      noShowRate: curDays.map((d) => noShowRateOn([d])),
      rating: curDays.map((d) => ratingOf([d])),
    },
  };

  // ---------------------------------------------------------------- branches
  let branches = null as null | Array<Record<string, unknown>>;
  if (isOwner && ids.length > 1) {
    const open = countOf(openToday);
    const takings = new Map(branchMoney.map((m) => [m.salonId, m.gmvMinor]));
    const todayOf = (id: string, pred: (s: AppointmentStatus) => boolean) =>
      sum(branchToday.filter((r) => r.salonId === id && pred(r.status)).map((r) => r._count));
    branches = salons
      .map((s) => ({
        salonId: s.id,
        salonName: s.name,
        bookings: todayOf(s.id, (st) => st !== AppointmentStatus.CANCELLED),
        noShows: todayOf(s.id, (st) => st === AppointmentStatus.NO_SHOW),
        takingsMinor: takings.get(s.id) ?? 0,
        rating: s.rating,
        totalReviews: s.totalReviews,
        openSlotsToday: open.get(s.id) ?? 0,
      }))
      .sort((a, b) => b.bookings - a.bookings || b.takingsMinor - a.takingsMinor || a.salonName.localeCompare(b.salonName))
      .slice(0, MAX_LIST);
  }

  const approximatePins = salons.filter((s) => s.locationAccuracy !== LocationAccuracy.EXACT).length;

  return {
    scope: { salonId: requested ?? null, salonCount: ids.length, today },
    attention: {
      pendingConfirm,
      checkedInOver2h,
      unrecordedPayment,
      unrepliedReviews,
      appealsOpen,
      ...(isOwner && {
        duesMinor,
        payoutFailed,
        accountUnverified: !payoutAccount,
      }),
      approximatePins,
      noSlotsNext7Days: noSlots.slice(0, MAX_LIST).map((s) => s.id),
      noSlotsNext7DaysCount: noSlots.length,
    },
    today: todayStrip,
    setup: {
      percent: setupRows.length ? Math.round(sum(setupRows.map((r) => r.percent)) / setupRows.length) : 0,
      items: SETUP_ITEMS,
      salons: incomplete.slice(0, 20),
      incompleteCount: incomplete.length,
    },
    week,
    branches,
    branchesTotal: ids.length,
  };
};

/** GET /owner/home?salonId */
const home = catchAsync(async (req: Request, res: Response) => {
  const data = await getOwnerHome(withAccessCache(req), req.query);
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Home retrieved", data });
});

export const OwnerHome = { getOwnerHome, home };
