import { AppointmentStatus } from "@prisma/client";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { formatBDT } from "../../utils/money";
import {
  appointmentStartsAt,
  cancellationQuote,
} from "../Appointment/appointment.deposit";
import { AppointmentService } from "../Appointment/appointment.service";
import { ReviewService } from "../Review/review.service";
import type {
  AssistantAction,
  TurnContext,
  TurnResult,
} from "./assistant.actions";
import { loadSalon, renderDates, salonGone } from "./assistant.actions";
import { dateLabel, toYmd } from "./assistant.availability";
import {
  Block,
  BookingListItem,
  QuickReply,
  RescheduleInfo,
  bookingList,
  cancellationPreview,
  loginRequired,
  notice,
  quickReplies,
} from "./assistant.blocks";
import { ASSISTANT_PATH } from "./assistant.constants";
import { AssistantState, advance, clearFrom } from "./assistant.state";

/**
 * The other half of the lifecycle: the bookings a customer already has. Every
 * write here goes through the existing services — `cancelAppointment` and
 * `createReview` — so the chat adds no money code and no second rule about
 * when a booking may be cancelled or reviewed.
 */

const LIST_SIZE = 5;
const REVIEW_ASK_WINDOW_MS = 48 * 60 * 60 * 1000;

/** The statuses a customer may still cancel or move themselves. A checked-in
 *  booking is the salon's to cancel. */
const CUSTOMER_CANCELLABLE: AppointmentStatus[] = [
  AppointmentStatus.PENDING,
  AppointmentStatus.CONFIRMED,
];

type Scope = "upcoming" | "past";

const signInFirst = (state: AssistantState, reason: string): TurnResult => ({
  text: reason,
  blocks: [loginRequired(reason, ASSISTANT_PATH)],
  state,
});

/** "Thu 24 Sep 17:45" — how a booking is named back to its customer. */
const whenLabel = (appointment: { appointmentDate: Date; startTime: string }) =>
  `${dateLabel(toYmd(appointment.appointmentDate))} ${appointment.startTime}`;

/**
 * `assertCancellable`'s rule, evaluated without throwing: a flag on a card is a
 * question, not an attempt, so it must not go through the asserting function.
 */
const stillCancellable = (
  appointment: { status: AppointmentStatus; appointmentDate: Date; startTime: string },
  now = new Date(),
) =>
  CUSTOMER_CANCELLABLE.includes(appointment.status) &&
  now.getTime() < appointmentStartsAt(appointment).getTime();

const STATUS_WORDS: Partial<Record<AppointmentStatus, string>> = {
  CANCELLED: "cancelled",
  COMPLETED: "completed",
  NO_SHOW: "marked as a no-show",
  IN_PROGRESS: "already under way",
  CHECKED_IN: "checked in",
};

/* ------------------------------------------------------------ my bookings */

type ListRow = Awaited<
  ReturnType<typeof AppointmentService.getMyAppointments>
>["data"][number];

const toItem = (row: ListRow, scope: Scope): BookingListItem => {
  const canCancel = stillCancellable(row);
  const actions: QuickReply[] = [];

  if (canCancel) {
    actions.push(
      {
        label: "Reschedule",
        action: { type: "reschedule", appointmentId: row.id },
        icon: "calendar",
      },
      {
        label: "Cancel",
        action: { type: "cancel_booking", appointmentId: row.id },
        style: "ghost",
      },
    );
  }

  if (scope === "past" && row.status === AppointmentStatus.COMPLETED) {
    actions.push({
      label: "Book again",
      action: { type: "book_usual", appointmentId: row.id },
      icon: "scissors",
    });
  }

  return {
    id: row.id,
    salonId: row.salonId,
    salonName: row.salon.name,
    salonPhone: row.salon.phone,
    serviceName: row.service.name,
    date: toYmd(row.appointmentDate),
    startTime: row.startTime,
    endTime: row.endTime,
    status: row.status,
    token: row.token,
    serialNumber: row.serialNumber,
    counterName: row.counter?.name ?? null,
    totalMinor: row.totalMinor,
    depositMinor: row.depositMinor,
    dueAtSalonMinor: Math.max(row.totalMinor - row.depositMinor, 0),
    canCancel,
    canReschedule: canCancel,
    actions,
  };
};

const listTurn = async (
  state: AssistantState,
  userId: string,
  scope: Scope,
  lead: Block[] = [],
  leadText = "",
): Promise<TurnResult> => {
  const { data } = await AppointmentService.getMyAppointments(userId, {
    limit: LIST_SIZE,
    scope,
  });
  const bookings = data.map((row) => toItem(row, scope));

  const other: QuickReply =
    scope === "upcoming"
      ? { label: "Past bookings", action: { type: "my_bookings", scope: "past" }, style: "ghost" }
      : { label: "Upcoming", action: { type: "my_bookings", scope: "upcoming" }, style: "ghost" };

  const chips = quickReplies([
    ...(bookings.length === 0
      ? [
          {
            label: "📍 Find salons near me",
            action: { type: "find_nearby" },
            style: "primary",
            icon: "map-pin",
          } as QuickReply,
        ]
      : []),
    other,
    { label: "Start over", action: { type: "restart" }, style: "ghost" },
  ]);

  const said =
    bookings.length === 0
      ? scope === "upcoming"
        ? "You have no upcoming bookings."
        : "No past bookings yet."
      : scope === "upcoming"
        ? `Your next ${bookings.length === 1 ? "booking" : `${bookings.length} bookings`}, soonest first.`
        : "Your most recent bookings.";

  return {
    text: leadText ? `${leadText} ${said}` : said,
    blocks: [
      ...lead,
      ...(bookings.length ? [bookingList({ scope, bookings })] : []),
      chips,
    ],
    state,
  };
};

const handleMyBookings = async (
  state: AssistantState,
  ctx: TurnContext,
  action: Extract<AssistantAction, { type: "my_bookings" }>,
): Promise<TurnResult> => {
  if (!ctx.userId) return signInFirst(state, "Sign in to see your bookings.");
  return listTurn(state, ctx.userId, action.scope ?? "upcoming");
};

/* ----------------------------------------------------------------- cancel */

/** One of the customer's own bookings, or null — someone else's booking reads
 *  exactly like one that does not exist. */
const loadOwn = (userId: string, appointmentId: string) =>
  prisma.appointment.findFirst({
    where: { id: appointmentId, customerId: userId },
    include: {
      salon: {
        select: { id: true, name: true, phone: true, cancellationWindowMin: true },
      },
      service: { select: { id: true, name: true } },
    },
  });

const notYours = async (
  state: AssistantState,
  userId: string,
): Promise<TurnResult> => {
  const text = "I could not find that booking. Here are the ones you have.";
  return listTurn(state, userId, "upcoming", [notice("warn", text)], text);
};

/** A booking that is past the point of cancelling by tap. */
const cannotCancel = async (
  state: AssistantState,
  userId: string,
  appointment: NonNullable<Awaited<ReturnType<typeof loadOwn>>>,
): Promise<TurnResult> => {
  const words = STATUS_WORDS[appointment.status] ?? "no longer active";
  const text = CUSTOMER_CANCELLABLE.includes(appointment.status)
    ? // Still live, so it is the clock that stopped it.
      `This appointment has already started. Please call the salon: ${appointment.salon.phone}.`
    : appointment.status === AppointmentStatus.CHECKED_IN
      ? `You have already checked in. Please ask ${appointment.salon.name} to cancel — ${appointment.salon.phone}.`
      : `That booking is ${words}, so there is nothing to change.`;

  return listTurn(state, userId, "upcoming", [notice("info", text)], text);
};

/** What the money does, in the customer's words. The same sentence shapes are
 *  used before (preview) and after (what actually happened). */
const moneyLine = (quote: {
  freeCancellation: boolean;
  depositMinor: number;
  penaltyMinor: number;
  penaltyPercent: number;
  refundMinor: number;
}) => {
  if (quote.depositMinor <= 0) return "No deposit is held for this booking.";
  if (quote.penaltyMinor <= 0) {
    return `Cancelling now is free — your ${formatBDT(quote.depositMinor)} deposit goes straight back.`;
  }
  return `Cancelling now keeps ${formatBDT(quote.penaltyMinor)} (${quote.penaltyPercent} %) of your ${formatBDT(quote.depositMinor)} deposit; ${formatBDT(quote.refundMinor)} returns to your wallet.`;
};

const handleCancelBooking = async (
  state: AssistantState,
  ctx: TurnContext,
  action: Extract<AssistantAction, { type: "cancel_booking" }>,
): Promise<TurnResult> => {
  if (!ctx.userId) return signInFirst(state, "Sign in to manage your bookings.");

  const appointment = await loadOwn(ctx.userId, action.appointmentId);
  if (!appointment) return notYours(state, ctx.userId);
  if (!CUSTOMER_CANCELLABLE.includes(appointment.status)) {
    return cannotCancel(state, ctx.userId, appointment);
  }

  // The same quote `cancelAppointment` applies, through the same function.
  const preview = await AppointmentService.getCancellationPreview(
    ctx.userId,
    appointment.id,
  );

  const what = `${appointment.service.name} at ${appointment.salon.name}, ${whenLabel(appointment)}`;

  const text = preview.cancellable
    ? `${what}. ${moneyLine(preview)}`
    : `This appointment has already started. Please call the salon: ${appointment.salon.phone}.`;

  const actions: QuickReply[] = preview.cancellable
    ? [
        {
          label: "Yes, cancel it",
          action: { type: "cancel_confirm", appointmentId: appointment.id },
          style: "primary",
        },
        {
          label: "Keep booking",
          action: { type: "my_bookings" },
          style: "ghost",
        },
      ]
    : [{ label: "My bookings", action: { type: "my_bookings" }, style: "ghost" }];

  return {
    text,
    blocks: [
      cancellationPreview({
        appointmentId: appointment.id,
        startsAt: preview.startsAt.toISOString(),
        freeCancellation: preview.freeCancellation,
        cancellationWindowMin: preview.cancellationWindowMin,
        depositMinor: preview.depositMinor,
        penaltyMinor: preview.penaltyMinor,
        penaltyPercent: preview.penaltyPercent,
        refundMinor: preview.refundMinor,
        cancellable: preview.cancellable,
        salonName: appointment.salon.name,
        salonPhone: appointment.salon.phone,
        serviceName: appointment.service.name,
        date: toYmd(appointment.appointmentDate),
        startTime: appointment.startTime,
        actions,
      }),
    ],
    state,
  };
};

/** What actually came back, from the cancel's own result — not the preview,
 *  which may be a minute stale by now. */
const cancelledLine = (result: {
  depositMinor: number;
  refundMinor: number;
  penaltyMinor: number;
  penaltyPercent: number;
}) => {
  if (result.depositMinor <= 0) return "Cancelled. No deposit was held.";
  if (result.penaltyMinor <= 0) {
    return `Cancelled. Your ${formatBDT(result.refundMinor)} deposit is back in your wallet.`;
  }
  return `Cancelled. ${formatBDT(result.penaltyMinor)} (${result.penaltyPercent} %) was kept as the late-cancellation fee and ${formatBDT(result.refundMinor)} is back in your wallet.`;
};

/**
 * Runs the customer's cancel exactly as `DELETE /appointments/:id` does. The
 * role is fixed to CUSTOMER: in the chat everyone is acting on a booking they
 * made for themselves, even a salon owner, who would otherwise be treated as
 * the salon cancelling (and paid a goodwill credit).
 */
export const cancelOwnBooking = (userId: string, appointmentId: string, reason: string) =>
  AppointmentService.cancelAppointment(userId, "CUSTOMER", appointmentId, reason);

const handleCancelConfirm = async (
  state: AssistantState,
  ctx: TurnContext,
  action: Extract<AssistantAction, { type: "cancel_confirm" }>,
): Promise<TurnResult> => {
  if (!ctx.userId) return signInFirst(state, "Sign in to manage your bookings.");

  const appointment = await loadOwn(ctx.userId, action.appointmentId);
  if (!appointment) return notYours(state, ctx.userId);
  if (!CUSTOMER_CANCELLABLE.includes(appointment.status)) {
    return cannotCancel(state, ctx.userId, appointment);
  }

  try {
    const result = await cancelOwnBooking(
      ctx.userId,
      appointment.id,
      "Cancelled by the customer in chat",
    );
    const text = cancelledLine(result);

    // A draft that was moving this booking has nothing left to move.
    const next =
      state.rescheduleOf === appointment.id
        ? (({ rescheduleOf: _gone, ...rest }) => rest)(state)
        : state;

    return listTurn(next, ctx.userId, "upcoming", [notice("info", text)], text);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;

    // Started in the seconds between the two taps, or already changed
    // elsewhere. Either way the salon is the one to talk to, and the list is
    // what is true now.
    const started = error.message.includes("already started");
    const text = started
      ? `This appointment has already started. Please call the salon: ${appointment.salon.phone}.`
      : error.message;

    return listTurn(state, ctx.userId, "upcoming", [notice("warn", text)], text);
  }
};

/* ------------------------------------------------------ reschedule / again */

/**
 * The booking's salon and service on the draft, and the funnel re-entered at
 * the date step. Everything else the draft held is dropped — a stale slot from
 * earlier must not ride into a move.
 */
const enterFunnel = async (
  state: AssistantState,
  appointment: { salonId: string; serviceId: string },
  lead: string,
  rescheduleOf?: string,
): Promise<TurnResult | null> => {
  const salon = await loadSalon(appointment.salonId);
  if (!salon) return null;

  const serviceActive = salon.services.some((s) => s.id === appointment.serviceId);

  const base = clearFrom(state, "salonId");
  delete base.wish;

  const next: AssistantState = {
    ...advance(base, { step: "date", salonId: salon.id }),
    ...(serviceActive ? { serviceId: appointment.serviceId } : {}),
    ...(rescheduleOf ? { rescheduleOf } : {}),
  };

  return renderDates(next, salon, lead);
};

const handleReschedule = async (
  state: AssistantState,
  ctx: TurnContext,
  action: Extract<AssistantAction, { type: "reschedule" }>,
): Promise<TurnResult> => {
  if (!ctx.userId) return signInFirst(state, "Sign in to manage your bookings.");

  const appointment = await loadOwn(ctx.userId, action.appointmentId);
  if (!appointment) return notYours(state, ctx.userId);
  if (!stillCancellable(appointment)) {
    return cannotCancel(state, ctx.userId, appointment);
  }

  const lead = `Moving your ${whenLabel(appointment)} ${appointment.service.name} at ${appointment.salon.name}. I will book the new time first and only then cancel this one.`;

  const turn = await enterFunnel(state, appointment, lead, appointment.id);
  return turn ?? salonGone(state);
};

const handleBookUsual = async (
  state: AssistantState,
  ctx: TurnContext,
  action: Extract<AssistantAction, { type: "book_usual" }>,
): Promise<TurnResult> => {
  if (!ctx.userId) return signInFirst(state, "Sign in to book again.");

  const appointment = await loadOwn(ctx.userId, action.appointmentId);
  if (!appointment) return notYours(state, ctx.userId);

  const turn = await enterFunnel(
    state,
    appointment,
    `${appointment.service.name} at ${appointment.salon.name} again.`,
  );
  return turn ?? salonGone(state);
};

/* ---------------------------------------------------------------- review */

const handleRateBooking = async (
  state: AssistantState,
  ctx: TurnContext,
  action: Extract<AssistantAction, { type: "rate_booking" }>,
): Promise<TurnResult> => {
  if (!ctx.userId) return signInFirst(state, "Sign in to leave a review.");

  let text: string;
  let tone: "info" | "warn" = "info";

  try {
    // The review endpoint's own service: completed, yours, and only once.
    await ReviewService.createReview(ctx.userId, {
      appointmentId: action.appointmentId,
      rating: action.rating,
    });
    text = `Thank you — ${action.rating} ${action.rating === 1 ? "star" : "stars"} saved.`;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    text = error.message;
    tone = "warn";
  }

  return {
    text,
    blocks: [
      notice(tone, text),
      quickReplies([
        {
          label: "📍 Find salons near me",
          action: { type: "find_nearby" },
          icon: "map-pin",
        },
        { label: "📅 My bookings", action: { type: "my_bookings" }, icon: "calendar" },
      ]),
    ],
    state,
  };
};

/* ----------------------------------------------------- returning customer */

/**
 * A review is asked for once per booking, ever: the claim is a conditional
 * write on `reviewAskedAt`, so two chats opening at once cannot both ask.
 * Only a booking completed in the last 48 hours and not yet reviewed.
 */
const reviewAsk = async (userId: string): Promise<Block[]> => {
  const since = new Date(Date.now() - REVIEW_ASK_WINDOW_MS);

  const due = await prisma.appointment.findFirst({
    where: {
      customerId: userId,
      status: AppointmentStatus.COMPLETED,
      review: { is: null },
      reviewAskedAt: null,
      OR: [
        { completedAt: { gte: since } },
        { completedAt: null, updatedAt: { gte: since } },
      ],
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      salon: { select: { name: true } },
      service: { select: { name: true } },
    },
  });
  if (!due) return [];

  const { count } = await prisma.appointment.updateMany({
    where: { id: due.id, reviewAskedAt: null },
    data: { reviewAskedAt: new Date() },
  });
  if (count === 0) return [];

  return [
    notice(
      "info",
      `How was your ${due.service.name} at ${due.salon.name}?`,
    ),
    quickReplies(
      [1, 2, 3, 4, 5].map((rating) => ({
        label: "★".repeat(rating),
        action: { type: "rate_booking", appointmentId: due.id, rating },
        ...(rating === 5 ? { style: "primary" as const } : {}),
      })),
    ),
  ];
};

/**
 * "Book Classic Haircut at Elegance again" — the most recent completed
 * booking, one query, skipped when its salon or service is no longer active.
 */
const usualChip = async (userId: string): Promise<QuickReply | null> => {
  const last = await prisma.appointment.findFirst({
    where: { customerId: userId, status: AppointmentStatus.COMPLETED },
    orderBy: [{ appointmentDate: "desc" }, { startTime: "desc" }],
    select: {
      id: true,
      salon: { select: { name: true, status: true, isDeleted: true } },
      service: { select: { name: true, isActive: true, isDeleted: true } },
    },
  });

  if (
    !last ||
    last.salon.status !== "ACTIVE" ||
    last.salon.isDeleted ||
    !last.service.isActive ||
    last.service.isDeleted
  ) {
    return null;
  }

  return {
    label: `Book ${last.service.name} at ${last.salon.name} again`,
    action: { type: "book_usual", appointmentId: last.id },
    style: "primary",
    icon: "scissors",
  };
};

/**
 * What a signed-in customer sees on top of the greeting: the review question
 * (once) and the "book my usual" chip. Best effort — a failure here must never
 * cost the customer their greeting.
 */
export const withReturningExtras = async (
  result: TurnResult,
  userId?: string,
): Promise<TurnResult> => {
  if (!userId) return result;

  try {
    const [review, usual] = await Promise.all([reviewAsk(userId), usualChip(userId)]);
    // The usual goes first: for a returning customer it is the whole booking
    // in two taps. The review question goes last, after what they came for.
    return {
      ...result,
      blocks: [
        ...(usual ? [quickReplies([usual])] : []),
        ...result.blocks,
        ...review,
      ],
    };
  } catch (error) {
    console.error("[assistant] returning-customer extras failed", error);
    return result;
  }
};

/* --------------------------------------------------------------- the move */

/**
 * What moving costs, for the summary card: cancelling the old booking now, by
 * the same quote the cancel will apply. Null when there is nothing to move any
 * more — it was cancelled or completed elsewhere — so the summary falls back
 * to an ordinary booking and says so.
 */
export const rescheduleInfo = async (
  userId: string | undefined,
  appointmentId: string | undefined,
): Promise<RescheduleInfo | null> => {
  if (!userId || !appointmentId) return null;

  const appointment = await loadOwn(userId, appointmentId);
  if (!appointment || !stillCancellable(appointment)) return null;

  const quote = cancellationQuote(appointment, appointment.salon);

  return {
    appointmentId: appointment.id,
    label: whenLabel(appointment),
    date: toYmd(appointment.appointmentDate),
    startTime: appointment.startTime,
    penaltyMinor: quote.penaltyMinor,
    depositMinor: quote.depositMinor,
    freeCancellation: quote.freeCancellation,
  };
};

/**
 * The second half of a move, run only after the new booking committed. If the
 * cancel fails both bookings stay, and the customer is told so plainly with
 * the way to cancel the old one — never a silent double booking, never a lost
 * slot.
 */
export const completeMove = async (
  userId: string,
  oldAppointmentId: string,
): Promise<{ moved: boolean; text: string; blocks: Block[] }> => {
  const old = await loadOwn(userId, oldAppointmentId);
  const label = old ? whenLabel(old) : "earlier";

  try {
    const result = await cancelOwnBooking(
      userId,
      oldAppointmentId,
      "Rescheduled by the customer in chat",
    );
    const text = `Moved — your ${label} booking is cancelled. ${cancelledLine(result).replace(/^Cancelled\. /, "")}`;
    return { moved: true, text, blocks: [notice("info", text)] };
  } catch (error) {
    const reason = error instanceof ApiError ? ` (${error.message})` : "";
    const text = `Your new time is booked, but I could not cancel your ${label} booking${reason}. You have both for now — cancel the old one below or from My bookings.`;
    console.error("[assistant] reschedule: old booking not cancelled", error);

    return {
      moved: false,
      text,
      blocks: [
        notice("warn", text),
        quickReplies([
          {
            label: "Cancel the old booking",
            action: { type: "cancel_booking", appointmentId: oldAppointmentId },
            style: "primary",
          },
          { label: "📅 My bookings", action: { type: "my_bookings" }, icon: "calendar" },
        ]),
      ],
    };
  }
};

export const AssistantManage = {
  handleMyBookings,
  handleCancelBooking,
  handleCancelConfirm,
  handleReschedule,
  handleBookUsual,
  handleRateBooking,
  listTurn,
  moneyLine,
  cancelledLine,
};
