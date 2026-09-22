import {
  Appointment,
  AppealStatus,
  DepositStatus,
  Prisma,
  Salon,
  UserRole,
  WalletTxType,
} from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { formatBDT } from "../../utils/money";
import { atWallClock } from "../../utils/slotTime";
import { sendEmail } from "../../utils/emailSender";
import {
  getDepositForfeitedTemplate,
  getDepositReleasedTemplate,
} from "../../utils/emailTemplates";
import { WalletService } from "../Wallet/wallet.service";
import { SettlementService } from "../Settlement/settlement.service";

/**
 * What happens to a deposit, and when.
 *
 * Every outcome below is keyed by appointment id inside WalletService, so a
 * double-click, a retried request or an overlapping job can call any of these
 * twice without the customer paying twice.
 */

/** Platform bounds. A salon can set its own policy, but not outside these. */
const PLATFORM_MIN_DEPOSIT_MINOR = 2000; // BDT 20
const PLATFORM_MAX_DEPOSIT_MINOR = 50000; // BDT 500

/** Salon-funded apology when the salon is the one who cancels. */
const GOODWILL_CREDIT_MINOR = 2000; // BDT 20

/** How long a customer has to dispute a no-show. Publish this number. */
export const APPEAL_WINDOW_MS = 48 * 60 * 60 * 1000;

/** How late a customer can be before the auto no-show job gives up on them. */
const NO_SHOW_GRACE_MIN = Number(process.env.NO_SHOW_GRACE_MINUTES ?? 20);

/**
 * What a customer loses for cancelling inside the salon's window. Outside the
 * window a cancellation is free; inside it the slot is too close to resell, so
 * the salon keeps a slice - but only a slice. Forfeiting the whole deposit is
 * what a no-show costs, and someone who tells us an hour ahead is not the same
 * as someone who never turns up.
 *
 * Read on use, not at import: dotenv runs after this module is first loaded.
 */
const latePenaltyPercent = () => {
  const parsed = Number(process.env.LATE_CANCELLATION_PENALTY_PERCENT ?? 20);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(Math.max(parsed, 0), 100);
};

const latePenaltyMinor = (depositMinor: number) =>
  Math.min(
    Math.round((depositMinor * latePenaltyPercent()) / 100),
    Math.max(depositMinor, 0),
  );

/**
 * `depositPercent` wins when the salon set one - for a bridal or keratin
 * booking a flat BDT 30 is not a deterrent. Either way the result is clamped
 * to the platform band, and never exceeds the bill itself.
 */
export const resolveDepositMinor = (
  salon: Pick<Salon, "depositMinor" | "depositPercent">,
  servicePriceMinor: number,
): number => {
  if (servicePriceMinor <= 0) return 0;

  const raw =
    salon.depositPercent != null
      ? Math.round((servicePriceMinor * salon.depositPercent) / 100)
      : salon.depositMinor;

  if (raw <= 0) return 0;

  const clamped = Math.min(
    Math.max(raw, PLATFORM_MIN_DEPOSIT_MINOR),
    PLATFORM_MAX_DEPOSIT_MINOR,
  );

  // A deposit larger than the bill is never what anyone meant.
  return Math.min(clamped, servicePriceMinor);
};

/**
 * Slots are generated with `setHours` against the slot's date, so the stored
 * "HH:mm" is server-local. Reading it back the same way keeps the cancellation
 * window honest; if this API ever serves multiple timezones, this is the one
 * place that has to learn about them.
 */
export const appointmentStartsAt = (
  appointment: Pick<Appointment, "appointmentDate" | "startTime">,
): Date => atWallClock(appointment.appointmentDate, appointment.startTime);

/**
 * When the chair is free again. `endTime` is written at booking from the slot,
 * but bookings made before that was stored fall back to the start - a zero
 * length appointment is wrong, but it is never wrong in the customer's favour
 * by more than the grace period.
 */
export const appointmentEndsAt = (
  appointment: Pick<Appointment, "appointmentDate" | "startTime" | "endTime">,
): Date => {
  if (!appointment.endTime) return appointmentStartsAt(appointment);

  const endsAt = atWallClock(appointment.appointmentDate, appointment.endTime);

  // An appointment that runs past midnight has an end time earlier in the day
  // than its start; roll it forward rather than returning a time in the past.
  const startsAt = appointmentStartsAt(appointment);
  if (endsAt.getTime() < startsAt.getTime()) {
    endsAt.setDate(endsAt.getDate() + 1);
  }

  return endsAt;
};

/** True while the customer can still cancel for free. */
export const isWithinFreeCancellation = (
  appointment: Pick<Appointment, "appointmentDate" | "startTime">,
  salon: Pick<Salon, "cancellationWindowMin">,
  now = new Date(),
): boolean => {
  const startsAt = appointmentStartsAt(appointment);
  const windowMs = salon.cancellationWindowMin * 60 * 1000;
  return startsAt.getTime() - now.getTime() >= windowMs;
};

/**
 * Once the appointment has started there is nothing left to cancel - the chair
 * was held, the slot is gone, and what happens next is either a completion or
 * a no-show. Letting a customer cancel at that point would be a way to dodge
 * the forfeit by a single click.
 */
export const assertCancellable = (
  appointment: Pick<Appointment, "appointmentDate" | "startTime">,
  now = new Date(),
) => {
  if (now.getTime() >= appointmentStartsAt(appointment).getTime()) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "This appointment has already started and can no longer be cancelled. Please contact the salon.",
    );
  }
};

/**
 * What cancelling right now costs. One function so the preview endpoint, the
 * cancel endpoint and the status endpoint can never disagree about the number
 * the customer was shown.
 */
export const cancellationQuote = (
  appointment: Pick<
    Appointment,
    "appointmentDate" | "startTime" | "depositMinor"
  >,
  salon: Pick<Salon, "cancellationWindowMin">,
  now = new Date(),
) => {
  const startsAt = appointmentStartsAt(appointment);
  const free = isWithinFreeCancellation(appointment, salon, now);
  const deposit = Math.max(appointment.depositMinor, 0);
  const penaltyMinor = free ? 0 : latePenaltyMinor(deposit);

  return {
    startsAt,
    started: now.getTime() >= startsAt.getTime(),
    freeCancellation: free,
    cancellationWindowMin: salon.cancellationWindowMin,
    penaltyPercent: free ? 0 : latePenaltyPercent(),
    depositMinor: deposit,
    penaltyMinor,
    refundMinor: deposit - penaltyMinor,
  };
};

type AppointmentWithSalon = Appointment & { salon: Salon };

const loadForSettlement = async (
  tx: Prisma.TransactionClient,
  appointmentId: string,
): Promise<AppointmentWithSalon | null> =>
  tx.appointment.findUnique({
    where: { id: appointmentId },
    include: { salon: true },
  });

const notify = (
  customerId: string,
  subject: string,
  build: (name: string) => string,
) => {
  void (async () => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: customerId },
        select: { name: true, email: true },
      });
      if (!user?.email) return;
      await sendEmail(user.email, subject, build(user.name || "there"));
    } catch (error) {
      console.error("[deposit.notify] email failed", error);
    }
  })();
};

// ---------------------------------------------------------------------------
// Outcomes
//
// Each outcome comes in three parts: `settleXTx` does the money movement inside
// a caller's transaction, `notifyX` sends the email once that transaction has
// committed, and `settleX` runs both on its own for callers that have no
// transaction of their own. Use the Tx form whenever the status change and the
// settlement must commit together.
// ---------------------------------------------------------------------------

const SETTLEMENT_TX_OPTIONS = { timeout: 15000, maxWait: 10000 };

/**
 * Completed: the deposit comes off the bill and becomes money owed to the
 * salon, less our flat 10% commission. The customer pays the remainder at
 * the counter.
 */
export const settleCompletedTx = async (
  tx: Prisma.TransactionClient,
  appointmentId: string,
) => {
  const appointment = await loadForSettlement(tx, appointmentId);
  if (!appointment) return null;

  if (
    appointment.depositStatus === DepositStatus.HELD &&
    appointment.depositMinor > 0
  ) {
    await WalletService.applyDeposit(
      appointment.customerId,
      appointment.depositMinor,
      appointment.id,
      tx,
    );

    await tx.appointment.update({
      where: { id: appointment.id },
      data: { depositStatus: DepositStatus.APPLIED },
    });
  }

  const commissionMinor = SettlementService.resolveCommissionMinor(
    appointment.totalMinor,
  );

  await SettlementService.recordCompletedBooking(
    tx,
    { ...appointment, depositStatus: DepositStatus.APPLIED },
    commissionMinor,
  );

  return appointment;
};

export const settleCompleted = async (appointmentId: string) => {
  await prisma.$transaction(
    (tx) => settleCompletedTx(tx, appointmentId),
    SETTLEMENT_TX_OPTIONS,
  );
};

/**
 * Cancelled in time, or cancelled by the salon: the hold is released and the
 * money is spendable again immediately. No gateway reversal, no 3-10 day wait.
 */
export const settleReleasedTx = async (
  tx: Prisma.TransactionClient,
  appointmentId: string,
  options: { goodwill?: boolean } = {},
) => {
  const appointment = await loadForSettlement(tx, appointmentId);
  if (!appointment) return null;

  if (
    appointment.depositStatus === DepositStatus.HELD &&
    appointment.depositMinor > 0
  ) {
    await WalletService.releaseDeposit(
      appointment.customerId,
      appointment.depositMinor,
      appointment.id,
      tx,
    );

    await tx.appointment.update({
      where: { id: appointment.id },
      data: { depositStatus: DepositStatus.RELEASED },
    });
  }

  if (options.goodwill) {
    await WalletService.mutate(
      {
        userId: appointment.customerId,
        type: WalletTxType.GOODWILL_CREDIT,
        amount: GOODWILL_CREDIT_MINOR,
        description: "Goodwill credit - the salon cancelled your booking",
        referenceType: "APPOINTMENT",
        referenceId: appointment.id,
        idempotencyKey: `goodwill:${appointment.id}`,
      },
      tx,
    );

    await SettlementService.recordGoodwillCredit(
      tx,
      appointment,
      GOODWILL_CREDIT_MINOR,
    );
  }

  return appointment;
};

export const notifyReleased = (released: AppointmentWithSalon | null) => {
  if (released && released.depositMinor > 0) {
    notify(released.customerId, "Your deposit has been returned", (name) =>
      getDepositReleasedTemplate(
        name,
        formatBDT(released.depositMinor),
        released.salon.name,
      ),
    );
  }
};

export const settleReleased = async (
  appointmentId: string,
  options: { goodwill?: boolean } = {},
) => {
  const released = await prisma.$transaction(
    (tx) => settleReleasedTx(tx, appointmentId, options),
    SETTLEMENT_TX_OPTIONS,
  );

  notifyReleased(released);
};

/**
 * Cancelled inside the window but before the start: the salon keeps a penalty
 * slice of the deposit and the rest goes straight back to spendable balance.
 *
 * Two wallet movements rather than one, because they are different events and
 * the customer's transaction list should say so: a fee they paid, and a refund
 * they received. Both keys are derived from the appointment id, so a retry
 * replays them instead of charging twice.
 */
export const settleLateCancelledTx = async (
  tx: Prisma.TransactionClient,
  appointmentId: string,
) => {
  const appointment = await loadForSettlement(tx, appointmentId);
  if (!appointment) return null;

  if (
    appointment.depositStatus !== DepositStatus.HELD ||
    appointment.depositMinor <= 0
  ) {
    return null;
  }

  const penaltyMinor = latePenaltyMinor(appointment.depositMinor);
  const refundMinor = appointment.depositMinor - penaltyMinor;

  if (penaltyMinor > 0) {
    await WalletService.mutate(
      {
        userId: appointment.customerId,
        type: WalletTxType.DEPOSIT_FORFEIT,
        amount: -penaltyMinor,
        holdDelta: -penaltyMinor,
        description: `Late cancellation fee (${latePenaltyPercent()}% of your deposit)`,
        referenceType: "APPOINTMENT",
        referenceId: appointment.id,
        idempotencyKey: `late-cancel-fee:${appointment.id}`,
      },
      tx,
    );
  }

  if (refundMinor > 0) {
    await WalletService.mutate(
      {
        userId: appointment.customerId,
        type: WalletTxType.DEPOSIT_RELEASE,
        amount: 0,
        holdDelta: -refundMinor,
        description: "Deposit balance returned - booking cancelled",
        referenceType: "APPOINTMENT",
        referenceId: appointment.id,
        idempotencyKey: `late-cancel-refund:${appointment.id}`,
        metadata: { holdDeltaMinor: -refundMinor },
      },
      tx,
    );
  }

  await tx.appointment.update({
    where: { id: appointment.id },
    data: {
      depositStatus:
        penaltyMinor > 0
          ? DepositStatus.PARTIALLY_FORFEITED
          : DepositStatus.RELEASED,
    },
  });

  await SettlementService.recordLateCancellationPenalty(
    tx,
    appointment,
    penaltyMinor,
  );

  return { appointment, penaltyMinor, refundMinor };
};

export const notifyLateCancelled = (
  settled: Awaited<ReturnType<typeof settleLateCancelledTx>>,
) => {
  if (settled && settled.refundMinor > 0) {
    notify(
      settled.appointment.customerId,
      "Your deposit has been returned",
      (name) =>
        getDepositReleasedTemplate(
          name,
          formatBDT(settled.refundMinor),
          settled.appointment.salon.name,
        ),
    );
  }
};

export const settleLateCancelled = async (appointmentId: string) => {
  const settled = await prisma.$transaction(
    (tx) => settleLateCancelledTx(tx, appointmentId),
    SETTLEMENT_TX_OPTIONS,
  );

  notifyLateCancelled(settled);

  return settled;
};

/**
 * No-show, or a cancellation too late to refill the slot: the deposit is
 * forfeited and split with the salon. This is the whole point of the mechanic -
 * it is also why the appeal window exists.
 */
export const settleForfeitedTx = async (
  tx: Prisma.TransactionClient,
  appointmentId: string,
) => {
  const appointment = await loadForSettlement(tx, appointmentId);
  if (!appointment) return null;

  if (
    appointment.depositStatus !== DepositStatus.HELD ||
    appointment.depositMinor <= 0
  ) {
    return null;
  }

  await WalletService.forfeitDeposit(
    appointment.customerId,
    appointment.depositMinor,
    appointment.id,
    tx,
  );

  await tx.appointment.update({
    where: { id: appointment.id },
    data: {
      depositStatus: DepositStatus.FORFEITED,
      noShowMarkedAt: new Date(),
    },
  });

  await SettlementService.recordForfeitedDeposit(
    tx,
    appointment,
    appointment.salon.noShowSalonSharePct,
  );

  return appointment;
};

export const notifyForfeited = (forfeited: AppointmentWithSalon | null) => {
  if (forfeited) {
    notify(forfeited.customerId, "Your deposit was forfeited", (name) =>
      getDepositForfeitedTemplate(
        name,
        formatBDT(forfeited.depositMinor),
        forfeited.salon.name,
      ),
    );
  }
};

export const settleForfeited = async (appointmentId: string) => {
  const forfeited = await prisma.$transaction(
    (tx) => settleForfeitedTx(tx, appointmentId),
    SETTLEMENT_TX_OPTIONS,
  );

  notifyForfeited(forfeited);
};

// ---------------------------------------------------------------------------
// Appeals
// ---------------------------------------------------------------------------

const appealDeadline = (appointment: Appointment) =>
  new Date((appointment.noShowMarkedAt ?? appointment.updatedAt).getTime() + APPEAL_WINDOW_MS);

export const appealNoShow = async (
  userId: string,
  appointmentId: string,
  reason: string,
) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
  });

  if (!appointment) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Appointment not found");
  }

  if (appointment.customerId !== userId) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "You can only appeal your own bookings",
    );
  }

  if (appointment.depositStatus !== DepositStatus.FORFEITED) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "There is no forfeited deposit to appeal on this booking",
    );
  }

  if (appointment.appealStatus) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      "An appeal has already been submitted for this booking",
    );
  }

  if (Date.now() > appealDeadline(appointment).getTime()) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "The 48 hour appeal window for this booking has closed",
    );
  }

  return prisma.appointment.update({
    where: { id: appointmentId },
    data: {
      appealStatus: AppealStatus.PENDING,
      appealedAt: new Date(),
      appealReason: reason,
    },
  });
};

/**
 * An admin upholding an appeal gives the money back with an ADJUSTMENT and a
 * compensating ledger set. The original forfeit rows stay exactly where they
 * are - the ledger is append-only, so the history shows both.
 */
export const resolveAppeal = async (
  adminUserId: string,
  appointmentId: string,
  payload: { approve: boolean; note?: string },
) => {
  return prisma.$transaction(
    async (tx) => {
      const appointment = await loadForSettlement(tx, appointmentId);

      if (!appointment) {
        throw new ApiError(StatusCodes.NOT_FOUND, "Appointment not found");
      }

      if (appointment.appealStatus !== AppealStatus.PENDING) {
        throw new ApiError(
          StatusCodes.BAD_REQUEST,
          "This booking has no appeal awaiting review",
        );
      }

      if (!payload.approve) {
        return tx.appointment.update({
          where: { id: appointmentId },
          data: { appealStatus: AppealStatus.REJECTED },
        });
      }

      await WalletService.mutate(
        {
          userId: appointment.customerId,
          type: WalletTxType.ADJUSTMENT,
          amount: appointment.depositMinor,
          description: `Deposit returned - no-show appeal upheld${
            payload.note ? `: ${payload.note}` : ""
          }`,
          referenceType: "APPOINTMENT",
          referenceId: appointment.id,
          idempotencyKey: `appeal-refund:${appointment.id}`,
          metadata: { adminUserId, note: payload.note },
        },
        tx,
      );

      await SettlementService.reverseForfeitedDeposit(
        tx,
        appointment,
        appointment.salon.noShowSalonSharePct,
      );

      return tx.appointment.update({
        where: { id: appointmentId },
        data: {
          appealStatus: AppealStatus.APPROVED,
          depositStatus: DepositStatus.RELEASED,
        },
      });
    },
    { timeout: 15000, maxWait: 10000 },
  );
};

// ---------------------------------------------------------------------------
// Authorisation helper for NO_SHOW
// ---------------------------------------------------------------------------

/**
 * Only the salon or an admin may call a no-show, and only once the appointment
 * has actually started. Without the time check a salon could forfeit a deposit
 * for an appointment that has not happened yet.
 */
export const assertCanMarkNoShow = (
  userRole: string,
  appointment: Pick<Appointment, "appointmentDate" | "startTime">,
) => {
  if (userRole !== UserRole.SALON_OWNER && userRole !== UserRole.ADMIN) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "Only the salon or an admin can mark a booking as a no-show",
    );
  }

  if (appointmentStartsAt(appointment).getTime() > Date.now()) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "This booking has not started yet",
    );
  }
};

// ---------------------------------------------------------------------------
// Auto no-show
// ---------------------------------------------------------------------------

/**
 * Salon owners forget to mark no-shows, and an unresolved hold is money the
 * customer cannot spend. After the grace period, close it out automatically.
 *
 * Arrival is an explicit check-in, so only a booking nobody checked in can be a
 * no-show: a CHECKED_IN booking, or an IN_PROGRESS one with a `checkedInAt`, is
 * never touched here - the stale-checkout job closes those as completed.
 *
 * A booking still sitting at CONFIRMED past its start time was never begun, so
 * the grace runs from the start. IN_PROGRESS without a check-in only exists on
 * legacy rows the old auto-start job moved; those are measured from their
 * scheduled *end*, since the job may have started someone who was in the chair.
 */
export const autoMarkNoShows = async () => {
  const graceMs = NO_SHOW_GRACE_MIN * 60 * 1000;
  const cutoff = Date.now() - graceMs;

  // Cheap pre-filter on the date; the exact start time is a string, so the
  // per-row check below is what actually decides.
  const candidates = await prisma.appointment.findMany({
    where: {
      depositStatus: DepositStatus.HELD,
      appointmentDate: { lte: new Date() },
      OR: [
        { status: { in: ["PENDING", "CONFIRMED"] } },
        { status: "IN_PROGRESS", checkedInAt: null },
      ],
    },
    select: {
      id: true,
      status: true,
      appointmentDate: true,
      startTime: true,
      endTime: true,
    },
    take: 200,
  });

  const due = candidates.filter((appointment) =>
    appointment.status === "IN_PROGRESS"
      ? appointmentEndsAt(appointment).getTime() <= cutoff
      : appointmentStartsAt(appointment).getTime() <= cutoff,
  );

  let marked = 0;

  for (const appointment of due) {
    try {
      // Conditional on the status read above and on nobody having checked the
      // customer in since: if the salon acted first, this row is left alone
      // and its deposit is not settled.
      const forfeited = await prisma.$transaction(async (tx) => {
        const { count } = await tx.appointment.updateMany({
          where: {
            id: appointment.id,
            status: appointment.status,
            checkedInAt: null,
          },
          data: { status: "NO_SHOW" },
        });

        if (count !== 1) return undefined;

        return settleForfeitedTx(tx, appointment.id);
      }, SETTLEMENT_TX_OPTIONS);

      if (forfeited === undefined) continue;

      notifyForfeited(forfeited);
      marked += 1;
    } catch (error) {
      console.error(
        `[deposit.autoNoShow] could not close out appointment=${appointment.id}`,
        error,
      );
    }
  }

  if (marked) {
    console.log(`[deposit.autoNoShow] marked ${marked} booking(s) as no-show`);
  }

  return { checked: due.length, marked };
};

export const AppointmentDeposit = {
  resolveDepositMinor,
  appointmentStartsAt,
  appointmentEndsAt,
  isWithinFreeCancellation,
  assertCancellable,
  cancellationQuote,
  settleCompleted,
  settleCompletedTx,
  settleReleased,
  settleReleasedTx,
  notifyReleased,
  settleLateCancelled,
  settleLateCancelledTx,
  notifyLateCancelled,
  settleForfeited,
  settleForfeitedTx,
  notifyForfeited,
  appealNoShow,
  resolveAppeal,
  assertCanMarkNoShow,
  autoMarkNoShows,
  APPEAL_WINDOW_MS,
  GOODWILL_CREDIT_MINOR,
};
