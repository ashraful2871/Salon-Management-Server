import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { formatBDT } from "../../utils/money";
import {
  appointmentStartsAt,
  isWithinFreeCancellation,
} from "../Appointment/appointment.deposit";
import { AppointmentService } from "../Appointment/appointment.service";
import { runAction, type TurnResult } from "./assistant.actions";
import { Block, bookingConfirmed, notice, quickReplies } from "./assistant.blocks";
import { releaseSlot } from "./assistant.booking";
import { APPOINTMENTS_PATH, COPY, WALLET_PATH } from "./assistant.constants";
import { findOwned, recordTurn, type Owner } from "./assistant.service";
import { advance, readState, type AssistantState } from "./assistant.state";
import { verifyConfirm, type ConfirmPayload } from "./assistant.token";

/**
 * The only thing in the assistant that commits.
 *
 * Nothing that came out of the chat is trusted here. The token proves the
 * server quoted these figures to this user for this slot; availability,
 * ownership, the booking limits and the price are all re-derived from the
 * database, and the booking itself goes through `bookAppointment` — the same
 * path the review page uses. There is no second booking implementation, which
 * is why the deposit hold, the emails, the token and the serial are identical
 * whichever surface took the booking.
 */

/** Enough of an appointment to draw a confirmation card. */
export const confirmedInclude = {
  salon: { select: { id: true, name: true, address: true, phone: true } },
  service: { select: { id: true, name: true } },
  staff: { include: { user: { select: { id: true, name: true } } } },
  counter: true,
} as const;

type CardAppointment = {
  id: string;
  salonId: string;
  appointmentDate: Date;
  startTime: string;
  endTime: string | null;
  token: string | null;
  serialNumber: number | null;
  totalMinor: number;
  depositMinor: number;
  salon: { name: string; address: string; phone: string };
  service: { name: string };
  counter: { name: string } | null;
  staff: { user: { name: string | null } | null } | null;
};

/**
 * A failure that still has a chat turn to draw. The controller answers with the
 * mapped status and these blocks, so a lost slot or an empty wallet arrives as
 * a card the customer can act on rather than a stack trace.
 */
export class AssistantConfirmError extends Error {
  constructor(
    public statusCode: number,
    public turn: TurnResult,
    public conversationId: string,
  ) {
    super(turn.text);
    this.name = "AssistantConfirmError";
  }
}

/**
 * The confirmation card. Mirrors `BookingConfirmed.tsx` so the chat and the
 * website say the same things about the same booking.
 */
const confirmedBlock = async (
  appointment: CardAppointment,
): Promise<Block> => {
  const salon = await prisma.salon.findUnique({
    where: { id: appointment.salonId },
    select: {
      latitude: true,
      longitude: true,
      cancellationWindowMin: true,
    },
  });

  const dueAtSalonMinor = Math.max(
    appointment.totalMinor - appointment.depositMinor,
    0,
  );

  // The same arithmetic the cancellation endpoint does, through the same
  // helper, so the figure on the card is the one that decides a full refund.
  const freeUntil = salon
    ? new Date(
        appointmentStartsAt(appointment).getTime() -
          salon.cancellationWindowMin * 60 * 1000,
      )
    : null;

  const stillFree =
    salon !== null &&
    isWithinFreeCancellation(appointment, {
      cancellationWindowMin: salon.cancellationWindowMin,
    });

  return bookingConfirmed({
    appointmentId: appointment.id,
    token: appointment.token,
    serialNumber: appointment.serialNumber,
    salonName: appointment.salon.name,
    salonAddress: appointment.salon.address,
    salonPhone: appointment.salon.phone,
    serviceName: appointment.service.name,
    // Written as UTC midnight of the calendar day, so it must be read in UTC.
    date: appointment.appointmentDate.toISOString().slice(0, 10),
    startTime: appointment.startTime,
    endTime: appointment.endTime,
    counterName: appointment.counter?.name ?? null,
    staffName: appointment.staff?.user?.name ?? null,
    totalMinor: appointment.totalMinor,
    depositMinor: appointment.depositMinor,
    dueAtSalonMinor,
    freeCancellationUntil:
      stillFree && freeUntil ? freeUntil.toISOString() : null,
    mapUrl:
      salon?.latitude != null && salon.longitude != null
        ? `https://www.google.com/maps/search/?api=1&query=${salon.latitude},${salon.longitude}`
        : null,
    manageUrl: APPOINTMENTS_PATH,
  });
};

const confirmedTurn = async (
  appointment: CardAppointment,
  state: AssistantState,
): Promise<TurnResult> => {
  const dueAtSalonMinor = Math.max(
    appointment.totalMinor - appointment.depositMinor,
    0,
  );

  const serial = appointment.serialNumber
    ? ` You are serial #${appointment.serialNumber}.`
    : "";

  const due =
    dueAtSalonMinor > 0
      ? ` Pay ${formatBDT(dueAtSalonMinor)} at the salon.`
      : " Nothing more to pay at the salon.";

  return {
    text: `Booked. ${appointment.service.name} at ${appointment.salon.name}, ${appointment.startTime}.${serial}${due} The confirmation is on its way to your inbox.`,
    blocks: [
      await confirmedBlock(appointment),
      quickReplies([
        {
          label: "Another booking",
          action: { type: "find_nearby" },
          icon: "map-pin",
        },
        { label: "Start over", action: { type: "restart" }, style: "ghost" },
      ]),
    ],
    state: advance(state, { step: "booked" }),
  };
};

/**
 * A failure the customer can act on, drawn as the step they are actually at.
 * `runAction` is re-entered rather than reimplemented, so the recovery picker
 * is identical to the one the funnel itself would have drawn — and the same
 * call releases the hold, because leaving a summary is what that does.
 */
const recover = async (
  state: AssistantState,
  userId: string,
  conversationId: string,
  text: string,
): Promise<TurnResult> => {
  const fresh = await runAction(
    { ...state, step: "summary" },
    { type: "change", target: "slot" },
    { userId, conversationId },
  );

  return {
    text,
    blocks: [notice("warn", text), ...fresh.blocks],
    state: fresh.state,
  };
};

/** Kept at the summary: a short wallet is one top-up away, not a lost booking,
 *  so the hold is deliberately *not* released. */
const walletShort = (state: AssistantState, message: string): TurnResult => ({
  text: message,
  blocks: [
    notice("warn", message),
    notice("info", COPY.topupSoon.replace("{path}", WALLET_PATH)),
    quickReplies([
      {
        label: "Add money to wallet",
        action: { type: "wallet" },
        style: "primary",
        icon: "wallet",
      },
      {
        label: "Change time",
        action: { type: "change", target: "slot" },
        style: "ghost",
      },
    ]),
  ],
  state,
});

type ConfirmInput = {
  confirmationToken: unknown;
  idempotencyKey: string;
  notes?: string;
  owner: Owner;
  /** From `auth(...)`, so always present. */
  userId: string;
};

const confirmBooking = async (input: ConfirmInput) => {
  const payload: ConfirmPayload = verifyConfirm(input.confirmationToken);

  // The token names the account it was quoted to. One that arrives on a
  // different account is not a mix-up to work around.
  if (payload.uid !== input.userId) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "That confirmation belongs to another account.",
    );
  }

  const conversation = await findOwned(payload.cid, input.owner);
  const state = readState(conversation.state);

  // Guard one of two: the key this chat already booked with. A double-tapped
  // Confirm, a retried request and a replayed call all land here and get the
  // appointment that exists rather than a second one.
  if (state.confirm?.key === input.idempotencyKey) {
    const existing = await prisma.appointment.findUnique({
      where: { id: state.confirm.appointmentId },
      include: confirmedInclude,
    });

    if (existing) {
      return {
        appointment: existing,
        replayed: true,
        turn: await confirmedTurn(existing, state),
        conversationId: payload.cid,
      };
    }
  }

  // The salon comes from the conversation, not the token: the state is
  // server-written and owner-checked, which is what makes `quoteBooking`'s
  // "this slot does not belong to the selected salon" check meaningful.
  if (!state.salonId) {
    throw new AssistantConfirmError(
      StatusCodes.CONFLICT,
      await recover(state, input.userId, payload.cid, COPY.staleTap),
      payload.cid,
    );
  }

  // Guard two is the conditional slot claim inside `bookAppointment`, which can
  // only ever win once. Everything between here and it is re-derived rather
  // than trusted, starting with the price.
  let quote;
  try {
    quote = await AppointmentService.quoteBooking(input.userId, {
      salonId: state.salonId,
      serviceId: payload.svc,
      counterId: payload.cnt,
      slotId: payload.sid,
      staffId: payload.stf ?? null,
    });
  } catch (error) {
    throw new AssistantConfirmError(
      error instanceof ApiError ? error.statusCode : StatusCodes.CONFLICT,
      await recover(
        state,
        input.userId,
        payload.cid,
        error instanceof ApiError ? error.message : COPY.slotTaken,
      ),
      payload.cid,
    );
  }

  // The figures moved under them. Booking at the new number without saying so
  // is not acceptable, however small the difference.
  if (quote.totalMinor !== payload.pm || quote.depositMinor !== payload.dm) {
    throw new AssistantConfirmError(
      StatusCodes.CONFLICT,
      await recover(state, input.userId, payload.cid, COPY.priceChanged),
      payload.cid,
    );
  }

  try {
    const appointment = await AppointmentService.bookAppointment(input.userId, {
      salonId: state.salonId,
      serviceId: payload.svc,
      counterId: payload.cnt,
      ...(payload.stf ? { staffId: payload.stf } : {}),
      slotId: payload.sid,
      ...(input.notes ? { notes: input.notes } : {}),
      bookedVia: "ASSISTANT",
    });

    // The slot is BOOKED, so the hold has already stopped mattering; the claim
    // clears it too. Tidiness, not correctness.
    await releaseSlot(payload.sid, input.userId);

    const turn = await confirmedTurn(appointment, state);

    await recordTurn(payload.cid, {
      action: { type: "confirm_booking" },
      label: "Confirm booking",
      result: {
        ...turn,
        state: {
          ...turn.state,
          confirm: {
            key: input.idempotencyKey,
            appointmentId: appointment.id,
          },
        },
      },
      conversation: { status: "BOOKED", appointmentId: appointment.id },
    });

    return { appointment, replayed: false, turn, conversationId: payload.cid };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;

    // The wallet is short. `bookAppointment` has already rolled the slot back,
    // and the hold is kept: the customer is one top-up away, and taking their
    // time away while they pay is the one thing that makes this unrecoverable.
    if (error.statusCode === StatusCodes.PAYMENT_REQUIRED) {
      throw new AssistantConfirmError(
        StatusCodes.PAYMENT_REQUIRED,
        walletShort(state, error.message),
        payload.cid,
      );
    }

    if (error.statusCode === StatusCodes.CONFLICT) {
      // An overlapping booking or the daily limit is about the customer's own
      // diary, not this slot: a fresh slot list would be answering a question
      // they did not ask. Their own words for it are the useful ones.
      const ownDiary = error.message.startsWith("You already have");

      throw new AssistantConfirmError(
        StatusCodes.CONFLICT,
        ownDiary
          ? {
              text: error.message,
              blocks: [
                notice("warn", error.message),
                notice(
                  "info",
                  `Your bookings are at ${APPOINTMENTS_PATH} if you want to move one.`,
                ),
                quickReplies([
                  {
                    label: "Change time",
                    action: { type: "change", target: "slot" },
                    style: "primary",
                  },
                  {
                    label: "Start over",
                    action: { type: "restart" },
                    style: "ghost",
                  },
                ]),
              ],
              state,
            }
          : await recover(state, input.userId, payload.cid, error.message),
        payload.cid,
      );
    }

    throw error;
  }
};

export const AssistantConfirm = {
  confirmBooking,
  confirmedBlock,
  confirmedTurn,
};

