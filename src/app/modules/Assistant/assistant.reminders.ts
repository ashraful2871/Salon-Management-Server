import { AppointmentStatus } from "@prisma/client";
import config from "../../../config";
import prisma from "../../shared/prisma";
import { sendEmail } from "../../utils/emailSender";
import { getBookingReminderTemplate } from "../../utils/emailTemplates";
import { formatBDT } from "../../utils/money";
import {
  appointmentStartsAt,
  cancellationQuote,
} from "../Appointment/appointment.deposit";
import { APPOINTMENTS_PATH } from "./assistant.constants";

/**
 * Booking reminders: one email about 24 hours before, one about 2 hours
 * before, CONFIRMED bookings only, email only.
 *
 * Idempotent by window plus stamp. A booking is picked only while it is inside
 * the window *and* its stamp is null, and the stamp is claimed with a
 * conditional write before the email is sent — so the job may run twice, on
 * two instances, or straight after a restart, and each reminder still goes out
 * once. The cost of claiming first is that a send which fails is not retried;
 * `sendEmail` never throws and logs its own failures.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const REMINDERS = [
  {
    field: "reminder24At",
    when: "tomorrow",
    from: 23 * HOUR,
    to: 25 * HOUR,
    // Booked in the last two hours: the confirmation is still fresh in the
    // inbox, and a "tomorrow" email on top of it is noise.
    skipIfBookedWithin: 2 * HOUR,
  },
  {
    field: "reminder2hAt",
    when: "in 2 hours",
    from: 105 * MINUTE,
    to: 135 * MINUTE,
    skipIfBookedWithin: 30 * MINUTE,
  },
] as const;

/** Walk-ins are given a placeholder address; there is nobody to email. */
const WALK_IN_EMAIL_DOMAIN = "walk-in.invalid";

const dayFormat = (date: Date) =>
  // The calendar day was written as UTC midnight, so it is read in UTC.
  date.toLocaleDateString("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

// Server-local, the same frame `atWallClock` builds the start time in, so the
// deadline reads as the wall-clock time the salon means.
const deadlineFormat = (instant: Date) =>
  instant.toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/**
 * `dryRun` reports what would be sent at `now` without claiming or emailing —
 * for checking the windows against the live data with the clock moved.
 */
export const sendBookingReminders = async (
  now = new Date(),
  { dryRun = false }: { dryRun?: boolean } = {},
) => {
  // Two calendar days either side is plenty for a 25-hour look-ahead; the
  // exact window is decided per booking below.
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const from = new Date(today.getTime() - 24 * HOUR);
  const to = new Date(today.getTime() + 3 * 24 * HOUR);

  const candidates = await prisma.appointment.findMany({
    where: {
      status: AppointmentStatus.CONFIRMED,
      appointmentDate: { gte: from, lt: to },
      OR: [{ reminder24At: null }, { reminder2hAt: null }],
    },
    include: {
      customer: { select: { name: true, email: true } },
      salon: {
        select: {
          name: true,
          address: true,
          phone: true,
          cancellationWindowMin: true,
        },
      },
      service: { select: { name: true } },
    },
  });

  let sent = 0;
  const picked: { id: string; reminder: string }[] = [];

  for (const appointment of candidates) {
    const email = appointment.customer?.email;
    if (!email || email.endsWith(`@${WALK_IN_EMAIL_DOMAIN}`)) continue;

    const startsAt = appointmentStartsAt(appointment);
    const until = startsAt.getTime() - now.getTime();
    const age = now.getTime() - appointment.createdAt.getTime();

    const due = REMINDERS.find(
      (r) =>
        appointment[r.field] === null &&
        until >= r.from &&
        until <= r.to &&
        age >= r.skipIfBookedWithin,
    );
    if (!due) continue;

    if (dryRun) {
      picked.push({ id: appointment.id, reminder: due.field });
      continue;
    }

    // The claim. Losing it means another run already sent this one.
    const { count } = await prisma.appointment.updateMany({
      where: {
        id: appointment.id,
        status: AppointmentStatus.CONFIRMED,
        [due.field]: null,
      },
      data: { [due.field]: now },
    });
    if (count === 0) continue;

    const freeUntil = new Date(
      startsAt.getTime() - appointment.salon.cancellationWindowMin * MINUTE,
    );
    // What cancelling costs once the window has closed, by the same quote the
    // cancel endpoint applies — asked about a moment just after the deadline.
    const late = cancellationQuote(appointment, appointment.salon, new Date(freeUntil.getTime() + MINUTE));

    const cancellation =
      appointment.depositMinor <= 0
        ? "Can't make it? Please cancel from your bookings so the salon can offer the time to someone else."
        : freeUntil.getTime() > now.getTime()
          ? `Free cancellation until <strong>${deadlineFormat(freeUntil)}</strong>. After that, cancelling keeps ${late.penaltyPercent}% of your ${formatBDT(appointment.depositMinor)} deposit.`
          : `Free cancellation has closed. Cancelling now keeps ${formatBDT(late.penaltyMinor)} of your ${formatBDT(appointment.depositMinor)} deposit; not turning up forfeits all of it.`;

    await sendEmail(
      email,
      due.when === "tomorrow"
        ? `Reminder: ${appointment.service.name} at ${appointment.salon.name} tomorrow`
        : `Reminder: ${appointment.service.name} at ${appointment.salon.name} in 2 hours`,
      getBookingReminderTemplate({
        customerName: appointment.customer.name ?? "there",
        when: due.when,
        salonName: appointment.salon.name,
        salonAddress: appointment.salon.address,
        salonPhone: appointment.salon.phone,
        serviceName: appointment.service.name,
        date: dayFormat(appointment.appointmentDate),
        time: appointment.startTime,
        token: appointment.token,
        serialNumber: appointment.serialNumber,
        dueAtSalon: formatBDT(
          Math.max(appointment.totalMinor - appointment.depositMinor, 0),
        ),
        cancellation,
        manageUrl: `${config.frontend_url}${APPOINTMENTS_PATH}`,
      }),
    );
    sent += 1;
  }

  if (sent) console.log(`[jobs] assistant.reminders: sent ${sent}`);
  return { checked: candidates.length, sent, picked };
};
