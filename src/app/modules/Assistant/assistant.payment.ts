import { IntentStatus } from "@prisma/client";
import { randomUUID } from "crypto";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { formatBDT } from "../../utils/money";
import { PaymentIntentService } from "../Payment/paymentIntent.service";
import {
  promptFor,
  readWallet,
  renderCurrent,
  runAction,
  walletBlock,
  walletOnly,
  type TurnContext,
  type TurnResult,
} from "./assistant.actions";
import { notice, quickReplies } from "./assistant.blocks";
import { heldUntilFor, holdSlot } from "./assistant.booking";
import { AssistantConfirm, AssistantConfirmError } from "./assistant.confirm";
import {
  ASSISTANT_TOPUP_ENABLED,
  COPY,
  TOPUP_HOLD_MINUTES,
  TOPUP_REUSE_MINUTES,
} from "./assistant.constants";
import type { TurnOutcome } from "./assistant.log";
import { findOwned, recordTurn, type Owner } from "./assistant.service";
import {
  readState,
  type AssistantState,
  type PendingTopup,
} from "./assistant.state";
import { peekConfirm, signConfirm } from "./assistant.token";

/**
 * Pay in chat — a doorway, not a second money path.
 *
 * The top-up itself is `PaymentIntentService.initiateTopup`, settled by the
 * IPN, the success redirect and the reconciliation sweep, and credited by
 * `creditSettledIntent` keyed on the transaction id. Nothing here touches a
 * balance. The chat only remembers which transaction it started
 * (`pendingTopup`) and, when asked, reads how it ended.
 */

/* ------------------------------------------------------------ serialising */

/**
 * One money turn per conversation at a time. A double-tapped "Top up & book",
 * or two tabs checking the same payment, would otherwise both read "nothing
 * started yet" or "not booked yet" and both act on it.
 *
 * A transaction-scoped advisory lock rather than `FOR UPDATE` on the
 * conversation: the work inside writes that very row from another connection
 * (`recordTurn`), which a row lock held here would deadlock.
 *
 * The timeout is generous on purpose. The work is the gateway's session call
 * or a whole booking — measured at 24 s against Neon from a local machine —
 * and the only thing this transaction holds is one idle connection. Running
 * out would not undo anything (the work commits on its own connection), but
 * the customer would lose the reply that says so.
 */
const serialised = <T>(conversationId: string, work: () => Promise<T>) =>
  prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${conversationId}::text, 0))`;
      return work();
    },
    { maxWait: 15_000, timeout: 120_000 },
  );

const openConversation = async (conversationId: string, owner: Owner) => {
  const conversation = await findOwned(conversationId, owner);

  // Same answer `runTurn` gives. The turn limit is deliberately not applied:
  // a customer who has paid must always be able to hear that it landed.
  if (conversation.status !== "ACTIVE") {
    throw new ApiError(
      StatusCodes.CONFLICT,
      "This conversation is closed. Start a new chat.",
    );
  }

  return conversation;
};

const withoutPending = (state: AssistantState): AssistantState => {
  const { pendingTopup: _pending, ...rest } = state;
  return rest;
};

/* ------------------------------------------------------------ the doorway */

/**
 * "Top up & book" needs something to book. The hold is extended once, to
 * `TOPUP_HOLD_MINUTES`, and the quote re-signed to lapse with it: same
 * figures, later expiry. So the token that books when the money lands is the
 * quote the customer was shown, and `confirmBooking` still re-checks it all.
 */
const holdForTopup = async (
  state: AssistantState,
  userId: string,
  conversationId: string,
): Promise<string | null> => {
  if (state.step !== "summary" || !state.slotId) return null;

  const quote = peekConfirm(state.quoteToken);
  if (
    !quote ||
    quote.sid !== state.slotId ||
    quote.uid !== userId ||
    quote.cid !== conversationId
  ) {
    return null;
  }

  if (!state.holdExtended) {
    // Also re-takes a hold that lapsed while they read the summary, provided
    // nobody else has taken the chair in the meantime.
    const held = await holdSlot(state.slotId, userId, TOPUP_HOLD_MINUTES);
    if (!held) return null;
  }

  const heldUntil = await heldUntilFor(state.slotId, userId);
  if (!heldUntil) return null;

  return signConfirm({ ...quote, exp: heldUntil.getTime() });
};

/** A gateway page still worth sending the customer back to. */
const stillOpen = async (userId: string, pending: PendingTopup) => {
  if (!pending.redirectUrl) return false;
  if (Date.now() - Date.parse(pending.startedAt) > TOPUP_REUSE_MINUTES * 60_000) {
    return false;
  }

  try {
    const intent = await PaymentIntentService.getIntentStatus(
      userId,
      pending.transactionId,
    );
    return intent.status === IntentStatus.PENDING;
  } catch {
    return false;
  }
};

type StartTopupInput = {
  conversationId: string;
  owner: Owner;
  /** From `auth(...)`: a guest has no wallet to top up. */
  userId: string;
  amountMinor: number;
  autoConfirm: boolean;
  label?: string;
};

const startTopup = (input: StartTopupInput) =>
  serialised(input.conversationId, async () => {
    // A card drawn before the switch was flipped can still be tapped.
    if (!ASSISTANT_TOPUP_ENABLED) {
      throw new ApiError(StatusCodes.SERVICE_UNAVAILABLE, COPY.topupPaused);
    }

    const conversation = await openConversation(
      input.conversationId,
      input.owner,
    );
    const state = readState(conversation.state);
    const ctx: TurnContext = {
      userId: input.userId,
      conversationId: conversation.id,
    };

    const action = {
      type: "start_topup",
      amountMinor: input.amountMinor,
      autoConfirm: input.autoConfirm,
    };
    const label =
      input.label ??
      `${input.autoConfirm ? "Top up & book" : "Top up"} ${formatBDT(input.amountMinor)}`;

    let next: AssistantState = state;
    let confirmToken: string | undefined;

    // Before any money moves: if the time they want to book is gone, say so
    // and show what is free instead of taking a payment for nothing.
    if (input.autoConfirm) {
      const token = await holdForTopup(state, input.userId, conversation.id);

      if (!token) {
        const fresh = await runAction(
          { ...state, step: "summary" },
          { type: "change", target: "slot" },
          ctx,
        );
        const turn: TurnResult = {
          text: COPY.topupNotHeld,
          blocks: [notice("warn", COPY.topupNotHeld), ...fresh.blocks],
          state: fresh.state,
        };

        return {
          started: false as const,
          ...(await recordTurn(conversation.id, {
            action,
            label,
            result: turn,
            step: state.step,
            signedIn: true,
          })),
        };
      }

      confirmToken = token;
      next = { ...next, quoteToken: token, holdExtended: true };
    }

    // A second tap on the same payment re-opens its page: one intent, not two.
    // The latest tap decides whether it also books.
    const open = state.pendingTopup;
    const reuse =
      open !== undefined &&
      open.amountMinor === input.amountMinor &&
      (await stillOpen(input.userId, open));

    const payment =
      reuse && open?.redirectUrl
        ? {
            redirectUrl: open.redirectUrl,
            transactionId: open.transactionId,
            amountMinor: open.amountMinor,
          }
        : await PaymentIntentService.initiateTopup(
            input.userId,
            input.amountMinor,
          );

    next = {
      ...next,
      pendingTopup: {
        transactionId: payment.transactionId,
        amountMinor: payment.amountMinor,
        autoConfirm: input.autoConfirm,
        ...(confirmToken ? { confirmToken } : {}),
        redirectUrl: payment.redirectUrl,
        startedAt:
          reuse && open ? open.startedAt : new Date().toISOString(),
      },
    };

    const recorded = await recordTurn(conversation.id, {
      action,
      label,
      result: {
        text: COPY.topupOpening,
        blocks: [notice("info", COPY.topupOpening)],
        state: next,
      },
      step: state.step,
      signedIn: true,
    });

    return {
      started: true as const,
      redirectUrl: payment.redirectUrl,
      transactionId: payment.transactionId,
      amountMinor: payment.amountMinor,
      autoConfirm: input.autoConfirm,
      ...recorded,
    };
  });

/* ------------------------------------------------------------- the answer */

type Outcome = {
  turn: TurnResult;
  /** The payment ended (or was never ours): written to the transcript. */
  terminal: boolean;
  appointmentId?: string;
  /** Set when the booking half was refused, for the turn log. */
  outcome?: TurnOutcome;
};

const paidLine = (pending: PendingTopup) =>
  COPY.topupPaid.replace("{amount}", formatBDT(pending.amountMinor));

/** The money is in; the time is not. Never implies the money went anywhere. */
const released = async (
  state: AssistantState,
  pending: PendingTopup,
  ctx: TurnContext,
): Promise<Outcome> => {
  const text = COPY.topupReleased.replace(
    "{amount}",
    formatBDT(pending.amountMinor),
  );
  const fresh = await runAction(
    { ...state, step: "summary" },
    { type: "change", target: "slot" },
    ctx,
  );

  return {
    turn: {
      text,
      blocks: [notice("info", text), ...fresh.blocks],
      state: fresh.state,
    },
    terminal: true,
  };
};

const paid = async (
  state: AssistantState,
  pending: PendingTopup,
  ctx: TurnContext & { userId: string },
  owner: Owner,
): Promise<Outcome> => {
  const lead = paidLine(pending);
  const paidNotice = notice("info", lead);

  // Topped up from the wallet chip or mid-funnel: nothing to book yet, so the
  // new balance and the step they were on.
  if (state.step !== "summary" || !state.slotId) {
    const wallet = await readWallet(ctx.userId);
    const current = await renderCurrent(state);

    return {
      turn: {
        text: `${lead} You have ${formatBDT(wallet.availableMinor)} available.`,
        blocks: [paidNotice, walletBlock(wallet, 0, false), ...current.blocks],
        state: current.state,
      },
      terminal: true,
    };
  }

  if (!(await heldUntilFor(state.slotId, ctx.userId))) {
    return released(state, pending, ctx);
  }

  // "Top up & book", still on the summary it was tapped on: book it now. The
  // key is the transaction, so however many times this runs for one payment,
  // it is one appointment.
  const quote = pending.autoConfirm ? peekConfirm(pending.confirmToken) : null;

  if (quote && quote.sid === state.slotId) {
    try {
      const result = await AssistantConfirm.confirmBooking({
        confirmationToken: pending.confirmToken,
        idempotencyKey: `topup:${pending.transactionId}`,
        owner,
        userId: ctx.userId,
        record: false,
      });

      return {
        turn: {
          text: `${lead} ${result.turn.text}`,
          blocks: [paidNotice, ...result.turn.blocks],
          state: withoutPending(result.turn.state),
        },
        terminal: true,
        appointmentId: result.appointment.id,
      };
    } catch (error) {
      // A card to draw — the price moved, the wallet is still short, the diary
      // clashes. The money is in regardless, and the card says what is next.
      if (error instanceof AssistantConfirmError) {
        return {
          turn: {
            text: `${lead} ${error.turn.text}`,
            blocks: [paidNotice, ...error.turn.blocks],
            state: withoutPending(error.turn.state),
          },
          terminal: true,
          outcome: error.outcome,
        };
      }
      if (!(error instanceof ApiError)) throw error;
      // Anything else (a lapsed quote, say) falls through to a fresh summary.
    }
  }

  // "Top up only", or a booking that could not run on its own: the summary
  // again, re-quoted and re-held, with Confirm now open. One more tap books it.
  const again = await runAction(
    state,
    { type: "choose_slot", slotId: state.slotId },
    ctx,
  );

  return {
    turn: {
      text: `${lead} ${again.text}`,
      blocks: [paidNotice, ...again.blocks],
      state: again.state,
    },
    terminal: true,
  };
};

/** Failed, cancelled or timed out: nothing was taken, and the hold is kept so
 *  trying again is one tap. */
const didNotPay = async (
  state: AssistantState,
  status: IntentStatus,
  failureReason: string | null,
  ctx: TurnContext,
): Promise<Outcome> => {
  const reason =
    status === IntentStatus.CANCELLED
      ? COPY.topupCancelled
      : status === IntentStatus.EXPIRED
        ? COPY.topupExpired
        : COPY.topupFailed;

  // The gateway's own words, when it gave some short enough to be useful.
  const detail =
    status === IntentStatus.FAILED &&
    failureReason &&
    failureReason.length <= 120
      ? ` (${failureReason})`
      : "";

  const wallet = await readWallet(ctx.userId);
  const text = `${reason}${detail} Try again whenever you are ready.`;

  return {
    turn: {
      text,
      blocks: [
        notice("warn", text),
        ...(wallet.isFrozen ? [] : [await promptFor(state, ctx.userId, wallet)]),
      ],
      state,
    },
    terminal: true,
  };
};

const waiting = (state: AssistantState): TurnResult => ({
  text: COPY.topupWaiting,
  blocks: [
    notice("info", COPY.topupWaiting),
    quickReplies([
      {
        label: "Check again",
        action: { type: "check_payment" },
        style: "primary",
        icon: "refresh",
      },
    ]),
  ],
  state,
});

/**
 * `check_payment`. Asks about the transaction this chat started — never the
 * redirect, which belongs to the wallet pages and SSLCommerz's own config.
 *
 * A background poll that finds the payment still pending is answered but not
 * written down: polling every few seconds must not fill the transcript, or
 * the turn limit, with "still waiting". A tap is always written, and so is
 * every ending.
 */
const checkPayment = (conversationId: string, owner: Owner, label?: string) =>
  serialised(conversationId, async () => {
    const conversation = await openConversation(conversationId, owner);
    const state = readState(conversation.state);
    const pending = state.pendingTopup;
    const userId = owner.userId;
    const ctx: TurnContext = { userId, conversationId: conversation.id };
    const started = Date.now();

    let payment: { transactionId: string; status: IntentStatus } | null = null;

    const answer = async (outcome: Outcome) => {
      if (!outcome.terminal && !label) {
        return {
          conversationId: conversation.id,
          state: outcome.turn.state,
          messages: [
            {
              id: randomUUID(),
              role: "ASSISTANT" as const,
              text: outcome.turn.text,
              blocks: outcome.turn.blocks,
              createdAt: new Date(),
            },
          ],
          recorded: false,
          payment,
        };
      }

      const recorded = await recordTurn(conversation.id, {
        action: { type: "check_payment" },
        label,
        result: outcome.turn,
        latencyMs: Date.now() - started,
        step: state.step,
        signedIn: Boolean(owner.userId || conversation.userId),
        ...(outcome.outcome ? { outcome: outcome.outcome } : {}),
        ...(outcome.appointmentId
          ? {
              conversation: {
                status: "BOOKED",
                appointmentId: outcome.appointmentId,
              },
            }
          : {}),
      });

      return {
        ...recorded,
        recorded: true,
        payment,
        ...(outcome.appointmentId
          ? { appointmentId: outcome.appointmentId }
          : {}),
      };
    };

    // Nothing in flight (or a guest, who cannot have started one): the wallet
    // and nothing else.
    if (!pending || !userId) {
      return answer({ turn: await walletOnly(state, ctx), terminal: false });
    }

    let intent;
    try {
      intent = await PaymentIntentService.getIntentStatus(
        userId,
        pending.transactionId,
      );
    } catch (error) {
      if (!(error instanceof ApiError) || error.statusCode !== StatusCodes.NOT_FOUND) {
        throw error;
      }
      // Not this account's, or gone. Stop asking about it.
      return answer({
        turn: await walletOnly(withoutPending(state), ctx),
        terminal: true,
      });
    }

    payment = { transactionId: pending.transactionId, status: intent.status };
    const settled = withoutPending(state);

    switch (intent.status) {
      case IntentStatus.SUCCESS:
        return answer(
          await paid(settled, pending, { ...ctx, userId }, owner),
        );
      case IntentStatus.FAILED:
      case IntentStatus.CANCELLED:
      case IntentStatus.EXPIRED:
        return answer(
          await didNotPay(settled, intent.status, intent.failureReason, ctx),
        );
      default:
        // INITIATED / PENDING. The IPN or the sweep will settle it whether or
        // not anyone is watching; this only reports.
        return answer({ turn: waiting(state), terminal: false });
    }
  });

export const AssistantPayment = { startTopup, checkPayment };
