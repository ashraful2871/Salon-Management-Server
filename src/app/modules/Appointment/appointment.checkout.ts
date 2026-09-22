import {
  AppointmentStatus,
  DepositStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  UserRole,
} from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import {
  assertCanActOnAppointment,
  ownedSalonIds,
} from "../../utils/salonAccess";
import { paymentSummary, withPaymentSummary } from "./appointment.billing";
import { AppointmentDeposit } from "./appointment.deposit";

/**
 * The counter side of a booking: find it by token, check the customer in, and
 * complete it while recording what the counter took. Completion, the deposit
 * settlement and the payment row commit in one transaction, so a booking is
 * never COMPLETED with its money half-recorded.
 */

type Actor = { userId: string; role: string };

type CounterMethod = "CASH" | "CARD" | "MOBILE_BANKING";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How early before the start time a customer may check in. */
const CHECK_IN_OPENS_MIN = 60;

/**
 * How long after its scheduled end a checked-in booking may sit open before
 * the job closes it. Generous on purpose: the salon closing it themselves is
 * always better, because only they know what the counter took.
 */
const STALE_CHECKOUT_HOURS = Number(process.env.STALE_CHECKOUT_HOURS ?? 12);

const TX_OPTIONS = { timeout: 15000, maxWait: 10000 };

const CONFLICT_MESSAGE =
  "This booking was already updated. Refresh and try again.";

/** Everything a single booking is shown with. `GET /appointments/:id` uses it too. */
export const appointmentDetailInclude = {
  customer: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      profilePhoto: true,
    },
  },
  salon: true,
  service: true,
  staff: {
    include: {
      user: {
        select: {
          id: true,
          name: true,
          profilePhoto: true,
          phone: true,
        },
      },
    },
  },
  counter: true,
  payment: true,
  review: true,
} satisfies Prisma.AppointmentInclude;

const receiptInclude = {
  payment: true,
  service: { select: { name: true } },
  counter: { select: { name: true } },
  customer: { select: { name: true } },
} satisfies Prisma.AppointmentInclude;

type ReceiptSource = Prisma.AppointmentGetPayload<{
  include: typeof receiptInclude;
}>;

const statusLabel = (status: AppointmentStatus) =>
  status.toLowerCase().replace("_", " ");

const checkInOpensAt = (
  appointment: Parameters<typeof AppointmentDeposit.appointmentStartsAt>[0],
) =>
  new Date(
    AppointmentDeposit.appointmentStartsAt(appointment).getTime() -
      CHECK_IN_OPENS_MIN * MINUTE_MS,
  );

const checkInOpensMessage = (appointment: {
  appointmentDate: Date;
  startTime: string;
}) => {
  // The date is stored as UTC midnight of the calendar day.
  const day = appointment.appointmentDate.toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `Check-in opens ${CHECK_IN_OPENS_MIN} minutes before ${appointment.startTime} on ${day}`;
};

/** Loads the bare row and refuses anyone who does not work for its salon. */
const loadForCounter = async (user: Actor, appointmentId: string) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
  });

  if (!appointment) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Appointment not found");
  }

  await assertCanActOnAppointment(user.userId, user.role, appointment.salonId);

  return appointment;
};

const loadDetail = async (appointmentId: string) =>
  withPaymentSummary(
    await prisma.appointment.findUniqueOrThrow({
      where: { id: appointmentId },
      include: appointmentDetailInclude,
    }),
  );

const toReceipt = (appointment: ReceiptSource) => {
  const { depositPaidMinor, paidAtCounterMinor } = paymentSummary(appointment);

  return {
    appointmentId: appointment.id,
    token: appointment.token,
    serialNumber: appointment.serialNumber,
    serviceName: appointment.service.name,
    counterName: appointment.counter?.name ?? null,
    customerName: appointment.customer.name,
    totalMinor: appointment.totalMinor,
    depositPaidMinor,
    collectedMinor: paidAtCounterMinor,
    paymentMethod: appointment.payment?.paymentMethod ?? null,
    completedAt: appointment.completedAt,
  };
};

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * The customer reads their token out at the counter. Accept it however it is
 * typed - "7kq2m" and "TKN-7KQ2M" are the same booking.
 */
const lookupByToken = async (user: Actor, rawToken: string) => {
  const trimmed = rawToken.trim().toUpperCase();
  if (!trimmed) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Enter a booking token");
  }
  const token = trimmed.startsWith("TKN-") ? trimmed : `TKN-${trimmed}`;

  const appointment = await prisma.appointment.findUnique({
    where: { token },
    include: appointmentDetailInclude,
  });

  const notFound = new ApiError(
    StatusCodes.NOT_FOUND,
    "No booking found for that token",
  );

  if (!appointment) throw notFound;

  // Another salon's booking reads as missing, so tokens cannot be probed
  // across salons.
  await assertCanActOnAppointment(
    user.userId,
    user.role,
    appointment.salonId,
  ).catch(() => {
    throw notFound;
  });

  return withPaymentSummary(appointment);
};

// ---------------------------------------------------------------------------
// Check in / start
// ---------------------------------------------------------------------------

/** CONFIRMED -> CHECKED_IN. Pressing it twice is harmless. */
const checkIn = async (user: Actor, appointmentId: string) => {
  const appointment = await loadForCounter(user, appointmentId);

  if (appointment.status === AppointmentStatus.CHECKED_IN) {
    return loadDetail(appointmentId);
  }

  if (appointment.status !== AppointmentStatus.CONFIRMED) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `Only a confirmed booking can be checked in - this one is ${statusLabel(appointment.status)}`,
    );
  }

  const now = new Date();

  if (now.getTime() < checkInOpensAt(appointment).getTime()) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      checkInOpensMessage(appointment),
    );
  }

  if (
    now.getTime() > AppointmentDeposit.appointmentEndsAt(appointment).getTime()
  ) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "This booking's time has passed",
    );
  }

  const { count } = await prisma.appointment.updateMany({
    where: { id: appointmentId, status: AppointmentStatus.CONFIRMED },
    data: {
      status: AppointmentStatus.CHECKED_IN,
      checkedInAt: now,
      checkedInById: user.userId,
    },
  });

  if (count === 0) {
    throw new ApiError(StatusCodes.CONFLICT, CONFLICT_MESSAGE);
  }

  return loadDetail(appointmentId);
};

/** CHECKED_IN -> IN_PROGRESS. Optional: a booking can go straight to checkout. */
const start = async (user: Actor, appointmentId: string) => {
  const appointment = await loadForCounter(user, appointmentId);

  if (appointment.status === AppointmentStatus.IN_PROGRESS) {
    return loadDetail(appointmentId);
  }

  if (appointment.status !== AppointmentStatus.CHECKED_IN) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `Check the customer in before starting - this booking is ${statusLabel(appointment.status)}`,
    );
  }

  const { count } = await prisma.appointment.updateMany({
    where: { id: appointmentId, status: AppointmentStatus.CHECKED_IN },
    data: { status: AppointmentStatus.IN_PROGRESS },
  });

  if (count === 0) {
    throw new ApiError(StatusCodes.CONFLICT, CONFLICT_MESSAGE);
  }

  return loadDetail(appointmentId);
};

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/**
 * Completes the booking and records what the counter took, as one write:
 * status COMPLETED, deposit APPLIED, and a COMPLETED payment for whatever the
 * deposit did not cover. Checking out a completed booking again returns the
 * same receipt rather than charging twice.
 */
const checkout = async (
  user: Actor,
  appointmentId: string,
  payload: { paymentMethod: CounterMethod; reference?: string },
) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: receiptInclude,
  });

  if (!appointment) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Appointment not found");
  }

  await assertCanActOnAppointment(user.userId, user.role, appointment.salonId);

  if (appointment.status === AppointmentStatus.COMPLETED) {
    return toReceipt(appointment);
  }

  const now = new Date();
  const allowedFrom: AppointmentStatus[] = [
    AppointmentStatus.CHECKED_IN,
    AppointmentStatus.IN_PROGRESS,
  ];

  // A customer the salon served without pressing "Check in" first. Once
  // check-in has opened, completing counts as checking them in too.
  if (appointment.status === AppointmentStatus.CONFIRMED) {
    if (now.getTime() < checkInOpensAt(appointment).getTime()) {
      throw new ApiError(
        StatusCodes.BAD_REQUEST,
        `This booking can't be completed yet. ${checkInOpensMessage(appointment)}`,
      );
    }
    allowedFrom.push(AppointmentStatus.CONFIRMED);
  } else if (!allowedFrom.includes(appointment.status)) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `Cannot complete a ${statusLabel(appointment.status)} booking`,
    );
  }

  const completed = await prisma.$transaction(async (tx) => {
    const { count } = await tx.appointment.updateMany({
      where: { id: appointmentId, status: { in: allowedFrom } },
      data: {
        status: AppointmentStatus.COMPLETED,
        completedAt: now,
        completedById: user.userId,
        checkedInAt: appointment.checkedInAt ?? now,
        checkedInById: appointment.checkedInById ?? user.userId,
      },
    });

    if (count === 0) {
      throw new ApiError(StatusCodes.CONFLICT, CONFLICT_MESSAGE);
    }

    await AppointmentDeposit.settleCompletedTx(tx, appointmentId);

    const settled = await tx.appointment.findUniqueOrThrow({
      where: { id: appointmentId },
      include: { payment: true },
    });

    const { amountDueMinor } = paymentSummary(settled);

    if (amountDueMinor > 0 && !settled.payment) {
      await tx.payment.create({
        data: {
          appointmentId,
          amountMinor: amountDueMinor,
          paymentMethod: payload.paymentMethod,
          status: PaymentStatus.COMPLETED,
          paymentDate: now,
          transactionId: payload.reference ?? null,
        },
      });
    }

    return tx.appointment.findUniqueOrThrow({
      where: { id: appointmentId },
      include: receiptInclude,
    });
  }, TX_OPTIONS);

  return toReceipt(completed);
};

// ---------------------------------------------------------------------------
// Cash summary
// ---------------------------------------------------------------------------

/** Statuses whose bill is still open at the counter. */
const OPEN_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.CHECKED_IN,
  AppointmentStatus.IN_PROGRESS,
];

/**
 * One day at the counter: what came in, by method, and what is still owed.
 * `expectedMinor` is `collectedMinor + outstandingMinor`, so the tiles always
 * add up. The day is the booking's calendar day, not the day money moved.
 */
const cashSummary = async (
  user: Actor,
  query: { date: string; salonId?: string },
) => {
  const from = new Date(`${query.date}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime())) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "date must be YYYY-MM-DD");
  }
  const to = new Date(from.getTime() + DAY_MS);

  let salonIds: string[];

  if (query.salonId) {
    await assertCanActOnAppointment(user.userId, user.role, query.salonId);
    salonIds = [query.salonId];
  } else if (user.role === UserRole.SALON_OWNER) {
    salonIds = await ownedSalonIds(user.userId);
  } else {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "Choose a salon to summarise",
    );
  }

  const appointments = await prisma.appointment.findMany({
    where: {
      salonId: { in: salonIds },
      appointmentDate: { gte: from, lt: to },
    },
    select: {
      status: true,
      totalMinor: true,
      depositMinor: true,
      depositStatus: true,
      payment: {
        select: { amountMinor: true, status: true, paymentMethod: true },
      },
    },
  });

  const countsByStatus = Object.fromEntries(
    Object.values(AppointmentStatus).map((status) => [status, 0]),
  ) as Record<AppointmentStatus, number>;

  // Keyed by payment method, values in poisha. ONLINE only appears if a legacy
  // row carries it, so the split always sums to `collectedMinor`.
  const collectedByMethod: Partial<Record<PaymentMethod, number>> = {
    CASH: 0,
    CARD: 0,
    MOBILE_BANKING: 0,
  };

  let collectedMinor = 0;
  let outstandingMinor = 0;
  let unrecordedCount = 0;
  let depositsAppliedMinor = 0;

  for (const appointment of appointments) {
    countsByStatus[appointment.status] += 1;

    const summary = paymentSummary(appointment);

    if (summary.paidAtCounterMinor > 0 && appointment.payment) {
      const method = appointment.payment.paymentMethod;
      collectedMinor += summary.paidAtCounterMinor;
      collectedByMethod[method] =
        (collectedByMethod[method] ?? 0) + summary.paidAtCounterMinor;
    }

    if (OPEN_STATUSES.includes(appointment.status)) {
      outstandingMinor += summary.amountDueMinor;
    }

    if (summary.paymentState === "UNRECORDED") unrecordedCount += 1;

    if (appointment.depositStatus === DepositStatus.APPLIED) {
      depositsAppliedMinor += appointment.depositMinor;
    }
  }

  return {
    date: query.date,
    salonId: query.salonId ?? null,
    countsByStatus,
    collectedMinor,
    collectedByMethod,
    outstandingMinor,
    expectedMinor: collectedMinor + outstandingMinor,
    unrecordedCount,
    depositsAppliedMinor,
  };
};

// ---------------------------------------------------------------------------
// Stale check-ins
// ---------------------------------------------------------------------------

/**
 * A customer who was checked in was served; nobody pressed "Complete". Close
 * the booking so the deposit is applied rather than held forever, but record
 * no payment - it then reads as UNRECORDED, for the salon to put right. This
 * job never produces a NO_SHOW.
 */
const autoCloseStaleCheckIns = async () => {
  const cutoff = Date.now() - STALE_CHECKOUT_HOURS * HOUR_MS;

  // Cheap pre-filter on the date; the end time is a "HH:mm" string, so the
  // per-row check below is what actually decides.
  const candidates = await prisma.appointment.findMany({
    where: {
      status: {
        in: [AppointmentStatus.CHECKED_IN, AppointmentStatus.IN_PROGRESS],
      },
      checkedInAt: { not: null },
      appointmentDate: { lte: new Date(cutoff) },
    },
    select: {
      id: true,
      status: true,
      appointmentDate: true,
      startTime: true,
      endTime: true,
    },
    orderBy: { appointmentDate: "asc" },
    take: 200,
  });

  const due = candidates.filter(
    (appointment) =>
      AppointmentDeposit.appointmentEndsAt(appointment).getTime() <= cutoff,
  );

  let closed = 0;

  for (const appointment of due) {
    try {
      const didClose = await prisma.$transaction(async (tx) => {
        const { count } = await tx.appointment.updateMany({
          where: {
            id: appointment.id,
            status: appointment.status,
            checkedInAt: { not: null },
          },
          data: {
            status: AppointmentStatus.COMPLETED,
            completedAt: new Date(),
            completedById: null,
          },
        });

        // The salon completed or cancelled it between the read and now.
        if (count === 0) return false;

        await AppointmentDeposit.settleCompletedTx(tx, appointment.id);
        return true;
      }, TX_OPTIONS);

      if (didClose) closed += 1;
    } catch (error) {
      console.error(
        `[appointment.autoClose] could not close appointment=${appointment.id}`,
        error,
      );
    }
  }

  if (closed) {
    console.log(
      `[appointment.autoClose] closed ${closed} stale check-in(s) without a payment record`,
    );
  }

  return { checked: due.length, closed };
};

export const AppointmentCheckout = {
  lookupByToken,
  checkIn,
  start,
  checkout,
  cashSummary,
  autoCloseStaleCheckIns,
};
