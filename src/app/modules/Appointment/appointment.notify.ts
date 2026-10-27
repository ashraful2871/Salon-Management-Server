import prisma from "../../shared/prisma";
import { formatBDT } from "../../utils/money";
import { notifyBranch } from "../../utils/notify";

import { SITE_NAME } from "../../utils/brand";
/**
 * Tells the branch about a booking that changed without them (owner Phase 13):
 * the customer cancelled, a no-show was recorded, the customer appealed one.
 * Once per booking and event; never throws.
 */
export const notifyBookingEvent = async (
  appointmentId: string,
  event: "booking.cancelled" | "booking.no_show" | "appeal.filed",
) => {
  try {
    const a = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        id: true,
        salonId: true,
        staffId: true,
        token: true,
        serialNumber: true,
        startTime: true,
        appointmentDate: true,
        depositMinor: true,
        appealReason: true,
        customer: { select: { name: true } },
        service: { select: { name: true } },
        salon: { select: { name: true } },
      },
    });
    if (!a) return;

    // Stored as UTC midnight of the calendar day (see bookAppointment).
    const day = a.appointmentDate.toLocaleDateString("en-GB", {
      timeZone: "UTC",
      day: "numeric",
      month: "short",
    });
    const who = a.customer?.name || "A customer";
    const what = `${a.service?.name ?? "Booking"}${a.serialNumber ? ` #${a.serialNumber}` : ""}`;
    const copy = {
      "booking.cancelled": {
        title: `${who} cancelled ${what}`,
        body: `${day}, ${a.startTime} at ${a.salon.name}. The slot is free again.`,
      },
      "booking.no_show": {
        title: `No-show: ${what}`,
        body: `${who} did not arrive for ${day}, ${a.startTime} at ${a.salon.name}.${
          a.depositMinor > 0 ? ` The ${formatBDT(a.depositMinor)} deposit was forfeited.` : ""
        }`,
      },
      "appeal.filed": {
        title: `${who} appealed a no-show`,
        body: `${what} on ${day} at ${a.salon.name}. ${SITE_NAME} reviews it within 48 hours${
          a.appealReason ? `. Their reason: "${a.appealReason.slice(0, 200)}"` : ""
        }.`,
      },
    }[event];

    await notifyBranch(
      a.salonId,
      event,
      {
        ...copy,
        link: `/dashboard/appointments?date=all&searchTerm=${a.token}`,
        dedupeKey: `${event}:${a.id}`,
      },
      { staffId: a.staffId },
    );
  } catch (err) {
    console.error(`[notify] ${event} for ${appointmentId} failed`, err);
  }
};
