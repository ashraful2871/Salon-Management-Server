import { AppealStatus, AppointmentStatus } from "@prisma/client";
import prisma from "../../../shared/prisma";
import { APPEAL_WINDOW_MS } from "../../Appointment/appointment.deposit";
import { maskEmail } from "../admin.service";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Every appeal awaiting a decision, the one waiting longest first. Test data
 * is not hidden: this is a work queue, and a test row says so with `isTest`.
 * `dueAt` is our promise to decide within 48 h of the appeal.
 */
const listPending = async () => {
  const rows = await prisma.appointment.findMany({
    where: { appealStatus: AppealStatus.PENDING },
    orderBy: [{ appealedAt: "asc" }, { id: "asc" }],
    take: 200,
    select: {
      id: true,
      token: true,
      serialNumber: true,
      status: true,
      appointmentDate: true,
      startTime: true,
      depositMinor: true,
      depositStatus: true,
      noShowMarkedAt: true,
      appealedAt: true,
      appealReason: true,
      checkedInAt: true,
      reminder24At: true,
      reminder2hAt: true,
      customerId: true,
      salonId: true,
      customer: { select: { id: true, name: true, email: true, isTest: true } },
      salon: { select: { id: true, name: true, area: true, isTest: true } },
      service: { select: { id: true, name: true } },
    },
  });

  const salonIds = [...new Set(rows.map((r) => r.salonId))];
  const customerIds = [...new Set(rows.map((r) => r.customerId))];
  const since = new Date(Date.now() - 90 * DAY);

  const [salonOutcomes, customerNoShows] = await Promise.all([
    salonIds.length
      ? prisma.appointment.groupBy({
          by: ["salonId", "status"],
          where: {
            salonId: { in: salonIds },
            appointmentDate: { gte: since },
            status: { in: [AppointmentStatus.COMPLETED, AppointmentStatus.NO_SHOW] },
          },
          _count: { _all: true },
        })
      : [],
    customerIds.length
      ? prisma.appointment.groupBy({
          by: ["customerId"],
          where: { customerId: { in: customerIds }, status: AppointmentStatus.NO_SHOW },
          _count: { _all: true },
        })
      : [],
  ]);

  const settled = new Map<string, { done: number; noShow: number }>();
  for (const s of salonOutcomes) {
    const entry = settled.get(s.salonId) ?? { done: 0, noShow: 0 };
    if (s.status === AppointmentStatus.NO_SHOW) entry.noShow += s._count._all;
    entry.done += s._count._all;
    settled.set(s.salonId, entry);
  }
  const noShowsByCustomer = new Map(customerNoShows.map((c) => [c.customerId, c._count._all]));

  return rows.map(({ customer, customerId, salonId, ...r }) => {
    const outcome = settled.get(salonId);
    return {
      ...r,
      dueAt: r.appealedAt ? new Date(r.appealedAt.getTime() + APPEAL_WINDOW_MS) : null,
      customer: { ...customer, email: maskEmail(customer.email) },
      remindersSent: [r.reminder24At ? "24h" : null, r.reminder2hAt ? "2h" : null].filter(Boolean),
      // Share of the salon's settled bookings (completed or no-show) in the
      // last 90 days that were no-shows; null with nothing settled.
      salonNoShowRate90d: outcome && outcome.done > 0 ? outcome.noShow / outcome.done : null,
      salonSettled90d: outcome?.done ?? 0,
      customerNoShows: noShowsByCustomer.get(customerId) ?? 0,
    };
  });
};

export const AdminAppealsService = { listPending };
