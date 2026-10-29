import { HomeBookingStatus } from "@prisma/client";
import prisma from "../../shared/prisma";

/**
 * Home Service timer jobs (registered in jobs/scheduler.ts). Each move is a
 * conditional update, so a run racing a payment or a second instance only
 * ever moves a booking once.
 */

/** `home.expire`: unpaid bookings past their payment window → EXPIRED, freeing the time. */
export const expireUnpaidHomeBookings = async () => {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE home_bookings SET status = 'EXPIRED', "updatedAt" = now()
    WHERE status = 'PENDING_PAYMENT' AND "expiresAt" < now()
    RETURNING id`;
  if (rows.length) {
    await prisma.homeBookingEvent.createMany({
      data: rows.map((r) => ({
        bookingId: r.id,
        fromStatus: HomeBookingStatus.PENDING_PAYMENT,
        toStatus: HomeBookingStatus.EXPIRED,
        actorRole: "SYSTEM",
        reason: "Not paid in time",
      })),
    });
  }
  return { expired: rows.length };
};
