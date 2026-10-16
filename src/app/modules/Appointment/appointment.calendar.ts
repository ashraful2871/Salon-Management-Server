import { AppointmentStatus, Prisma, SlotStatus, UserRole } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import config from "../../../config";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { AuditCtx, auditTx } from "../../utils/audit";
import { sendEmail } from "../../utils/emailSender";
import { getBookingRescheduledTemplate } from "../../utils/emailTemplates";
import { AccessUser, assertBookingPermission, assertSalonPermission, grantAt } from "../../utils/salonAccess";
import { hasSlotStarted } from "../../utils/slotTime";
import { addDays, dateOnly, daysBetween, DAY_MS, isDay } from "../Analytics/analytics.days";
import { paymentSummary } from "./appointment.billing";
import { AppointmentIdentity } from "./appointment.identity";
import { claimSlot } from "./appointment.service";
import { assertStaffWorking, offRanges } from "../Staff/staff.schedule";

/**
 * The owner's day planner. Times go out as wall-clock "YYYY-MM-DDTHH:mm"
 * strings with no zone: slots store a date plus "HH:mm" (see slotTime.ts), and
 * the grid only needs minutes since midnight, so nothing is converted.
 */

const MAX_DAYS = 7;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WALK_IN_EMAIL_DOMAIN = "walk-in.invalid";

const at = (date: Date, hhmm: string | null | undefined) => `${date.toISOString().slice(0, 10)}T${hhmm ?? "00:00"}`;

/** The end time, or start + duration when a row has none. */
const endOf = (start: string, end: string | null | undefined, durationMin: number) => {
  if (end) return end;
  const [h, m] = start.split(":").map(Number);
  const total = Math.min(h * 60 + m + (durationMin || 30), 24 * 60 - 1);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

const hhmm = (v: unknown) => {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(v ?? ""));
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : null;
};

/** One entry per day of the range, from the salon's published weekly hours. */
export const hoursFor = (hours: unknown, days: string[]) =>
  days.map((day) => {
    const weekday = WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()];
    const raw = hours && typeof hours === "object" ? (hours as Record<string, unknown>)[weekday] : undefined;
    if (!raw || typeof raw !== "object") return { day, open: null, close: null, closed: !!hours };
    const d = raw as Record<string, unknown>;
    const closed = d.closed === true || d.isClosed === true;
    return { day, open: closed ? null : hhmm(d.open), close: closed ? null : hhmm(d.close), closed };
  });

export type CalendarQuery = { salonId?: unknown; from?: unknown; to?: unknown; view?: unknown };

/** GET /appointments/calendar - one salon, at most seven days. */
const getCalendar = async (user: AccessUser, query: CalendarQuery) => {
  const salonId = typeof query.salonId === "string" ? query.salonId : "";
  if (!salonId) throw new ApiError(StatusCodes.BAD_REQUEST, "Pick one branch to see its calendar.");
  if (!isDay(query.from)) throw new ApiError(StatusCodes.BAD_REQUEST, "from must be a day in YYYY-MM-DD format.");
  const view = query.view === "week" ? "week" : "day";
  const from = query.from;
  const to = query.to === undefined ? (view === "week" ? addDays(from, 6) : from) : query.to;
  if (!isDay(to) || to < from) throw new ApiError(StatusCodes.BAD_REQUEST, "to must be a day on or after from.");
  const days = daysBetween(from, to);
  if (days.length > MAX_DAYS) throw new ApiError(StatusCodes.BAD_REQUEST, "The calendar shows at most 7 days.");

  await assertSalonPermission(user, salonId, "bookings.view");

  // A stylist sees their own column only, read-only.
  const grant = user.role === UserRole.ADMIN ? null : await grantAt(user, salonId);
  const ownStaff = grant?.ownBookingsOnly ? (grant.staffId ? { id: grant.staffId } : null) : null;
  if (grant?.ownBookingsOnly && !ownStaff) throw new ApiError(StatusCodes.NOT_FOUND, "Not found");

  const range = { gte: dateOnly(from), lt: new Date(dateOnly(to).getTime() + DAY_MS) };

  const [salon, staff, counters, bookings, slots] = await Promise.all([
    prisma.salon.findUnique({ where: { id: salonId }, select: { id: true, name: true, operatingHours: true } }),
    prisma.staff.findMany({
      where: { salonId, isDeleted: false, ...(ownStaff && { id: ownStaff.id }) },
      select: { id: true, user: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.counter.findMany({
      where: { salonId, isDeleted: false },
      select: { id: true, name: true, code: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.appointment.findMany({
      where: {
        salonId,
        appointmentDate: range,
        status: { not: AppointmentStatus.CANCELLED },
        ...(ownStaff && { staffId: ownStaff.id }),
      },
      select: {
        id: true,
        appointmentDate: true,
        startTime: true,
        endTime: true,
        status: true,
        token: true,
        serialNumber: true,
        staffId: true,
        counterId: true,
        serviceId: true,
        totalMinor: true,
        depositMinor: true,
        depositStatus: true,
        payment: { select: { amountMinor: true, status: true } },
        customer: { select: { name: true } },
        service: { select: { name: true, duration: true } },
      },
      orderBy: [{ appointmentDate: "asc" }, { startTime: "asc" }],
    }),
    ownStaff
      ? Promise.resolve([])
      : prisma.slot.findMany({
          where: { salonId, date: range, status: { in: [SlotStatus.AVAILABLE, SlotStatus.BLOCKED] }, isBooked: false },
          select: {
            id: true,
            date: true,
            startTime: true,
            endTime: true,
            status: true,
            counterId: true,
            serviceId: true,
            heldUntil: true,
            service: { select: { name: true } },
          },
          orderBy: [{ date: "asc" }, { startTime: "asc" }],
        }),
  ]);
  if (!salon) throw new ApiError(StatusCodes.NOT_FOUND, "Not found");

  // Stylists when the salon has any, else its counters. Slots belong to
  // counters, so in stylist mode open slots carry no resource (an "Open" lane).
  const byStaff = staff.length > 0;
  const resources: Array<{ id: string; kind: "STAFF" | "COUNTER"; name: string }> = byStaff
    ? staff.map((s) => ({ id: s.id, kind: "STAFF" as const, name: s.user.name }))
    : counters.map((c) => ({ id: c.id, kind: "COUNTER" as const, name: c.code ? `${c.name} (${c.code})` : c.name }));
  if (byStaff && !ownStaff && bookings.some((b) => !b.staffId)) {
    resources.push({ id: "unassigned", kind: "STAFF", name: "Unassigned" });
  }

  const off = byStaff ? await offRanges(staff.map((s) => s.id), days) : new Map();

  const now = new Date();
  const free = slots.filter((s) => s.status === SlotStatus.AVAILABLE && !(s.heldUntil && s.heldUntil > now));

  return {
    salon: { id: salon.id, name: salon.name },
    view,
    from,
    to,
    mode: byStaff ? ("STAFF" as const) : ("COUNTER" as const),
    readOnly: !!ownStaff,
    // Stylists carry `off`: outside their shifts ("OFF") and time off ("LEAVE").
    resources: resources.map((r) => (r.kind === "STAFF" && r.id !== "unassigned" ? { ...r, off: off.get(r.id) ?? [] } : r)),
    bookings: bookings.map((b) => ({
      id: b.id,
      resourceId: byStaff ? (b.staffId ?? "unassigned") : b.counterId,
      start: at(b.appointmentDate, b.startTime),
      end: at(b.appointmentDate, endOf(b.startTime, b.endTime, b.service.duration)),
      status: b.status,
      token: b.token,
      serialNumber: b.serialNumber,
      serviceId: b.serviceId,
      customerName: b.customer.name,
      serviceName: b.service.name,
      paymentState: paymentSummary(b).paymentState,
    })),
    blocked: slots
      .filter((s) => s.status === SlotStatus.BLOCKED)
      .map((s) => ({
        resourceId: byStaff ? null : s.counterId,
        start: at(s.date, s.startTime),
        end: at(s.date, s.endTime),
        reason: "Blocked",
      })),
    openSlots: free.map((s) => ({
      id: s.id,
      resourceId: byStaff ? null : s.counterId,
      serviceId: s.serviceId,
      serviceName: s.service?.name ?? null,
      start: at(s.date, s.startTime),
      end: at(s.date, s.endTime),
    })),
    hours: hoursFor(salon.operatingHours, days),
  };
};

const RESCHEDULABLE: AppointmentStatus[] = [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED];

/**
 * PATCH /appointments/:id/reschedule - move a booking into another free slot
 * of the same salon and service. Price, deposit and token stay; the old slot
 * opens again in the same transaction that claims the new one.
 */
const rescheduleAppointment = async (user: AccessUser, ctx: AuditCtx, id: string, slotId: string) => {
  const appt = await prisma.appointment.findUnique({
    where: { id },
    include: {
      salon: { select: { name: true } },
      service: { select: { name: true } },
      customer: { select: { name: true, email: true } },
    },
  });
  if (!appt) throw new ApiError(StatusCodes.NOT_FOUND, "Appointment not found");
  await assertBookingPermission(user, appt, "bookings.manage");

  if (!RESCHEDULABLE.includes(appt.status)) {
    throw new ApiError(StatusCodes.CONFLICT, "Only pending or confirmed bookings can be moved.");
  }

  const slot = await prisma.slot.findUnique({ where: { id: slotId } });
  if (!slot || slot.salonId !== appt.salonId) throw new ApiError(StatusCodes.NOT_FOUND, "Slot not found");
  if (slot.id === appt.slotId) throw new ApiError(StatusCodes.BAD_REQUEST, "The booking is already at that time.");
  if (slot.serviceId !== appt.serviceId) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "That time is for a different service.");
  }
  if (!slot.counterId) throw new ApiError(StatusCodes.BAD_REQUEST, "That slot has no counter, so it cannot be booked.");
  if (hasSlotStarted(slot)) throw new ApiError(StatusCodes.CONFLICT, "That time has already passed. Please pick a later slot.");
  // The stylist moves with the booking, so they must work the new time.
  if (appt.staffId) await assertStaffWorking({ id: appt.staffId }, slot.date, slot.startTime, slot.endTime);

  const before = {
    slotId: appt.slotId,
    date: appt.appointmentDate.toISOString().slice(0, 10),
    startTime: appt.startTime,
    counterId: appt.counterId,
    serialNumber: appt.serialNumber,
  };

  const updated = await prisma.$transaction(
    async (tx) => {
      // Any live hold blocks it: a customer mid-checkout has that time.
      await claimSlot(tx, slot, null);

      if (appt.slotId) {
        await tx.slot.updateMany({
          where: { id: appt.slotId },
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          data: { status: "AVAILABLE", isBooked: false },
        });
      }

      const serialNumber = await AppointmentIdentity.slotPosition(tx, slot);
      const row = await tx.appointment
        .update({
          where: { id, status: { in: RESCHEDULABLE } },
          data: {
            slotId: slot.id,
            appointmentDate: slot.date,
            startTime: slot.startTime,
            endTime: slot.endTime,
            counterId: slot.counterId!,
            serialNumber,
            // The reminders were for the old time.
            reminder24At: null,
            reminder2hAt: null,
          },
        })
        .catch((err: unknown) => {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
            throw new ApiError(StatusCodes.CONFLICT, "The booking changed meanwhile. Reload and try again.");
          }
          throw err;
        });

      await auditTx(tx, ctx, {
        action: "appointment.reschedule",
        entityType: "appointment",
        entityId: id,
        salonId: appt.salonId,
        before,
        after: {
          slotId: slot.id,
          date: slot.date.toISOString().slice(0, 10),
          startTime: slot.startTime,
          counterId: slot.counterId,
          serialNumber,
        },
      });
      return row;
    },
    { timeout: 15000, maxWait: 10000 },
  );

  const email = appt.customer.email;
  if (email && !email.endsWith(`@${WALK_IN_EMAIL_DOMAIN}`)) {
    const to = `${slot.date.toISOString().slice(0, 10)} at ${slot.startTime}`;
    // sendEmail never throws; the catch keeps a mail problem from failing the move.
    void sendEmail(
      email,
      `Your booking moved to ${to}`,
      getBookingRescheduledTemplate({
        name: appt.customer.name,
        salonName: appt.salon.name,
        serviceName: appt.service.name,
        token: appt.token,
        from: `${before.date} at ${before.startTime}`,
        to,
        contactUrl: `${config.frontend_url}/contact`,
      }),
    ).catch(() => undefined);
  }

  return updated;
};

export const AppointmentCalendar = { getCalendar, rescheduleAppointment };
