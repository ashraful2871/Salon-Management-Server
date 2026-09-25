import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { AssistantAction, runAction } from "./assistant.actions";
import { textTurn } from "./assistant.ai";
import { notice } from "./assistant.blocks";
import {
  COPY,
  GUEST_TTL_DAYS,
  MAX_TURNS,
  SIGNED_IN_TTL_DAYS,
} from "./assistant.constants";
import {
  logTurn,
  logUnrecorded,
  outcomeOf,
  type TurnOutcome,
} from "./assistant.log";
import { AssistantState, readState } from "./assistant.state";

/** Signed in → the account owns it. Guest → the `anonymousId` we handed back on
 *  create does, carried in `X-Assistant-Key`. */
export type Owner = { userId?: string; anonymousId?: string };

/** Pushed forward on every turn, so a chat expires that long after its *last*
 *  turn, not its first. */
const expiry = (signedIn: boolean) =>
  new Date(
    Date.now() +
      (signedIn ? SIGNED_IN_TTL_DAYS : GUEST_TTL_DAYS) * 24 * 60 * 60 * 1000,
  );

/**
 * Ownership is part of the lookup, not a check after it: a conversation that is
 * not yours is a conversation that does not exist. A 403 would confirm the id
 * is real.
 */
const ownerWhere = (
  id: string,
  owner: Owner,
): Prisma.AssistantConversationWhereInput | null => {
  if (owner.userId) {
    return {
      id,
      OR: [
        { userId: owner.userId },
        // A guest who signs in mid-chat still holds the key to their own chat.
        ...(owner.anonymousId
          ? [{ anonymousId: owner.anonymousId, userId: null }]
          : []),
      ],
    };
  }

  if (owner.anonymousId) {
    return { id, anonymousId: owner.anonymousId };
  }

  // No token and no key: there is nothing to match against, so don't ask the
  // database a question whose only honest answer is "not found".
  return null;
};

/** Loads a conversation the caller owns, or throws the same 404 either way. */
export const findOwned = async (id: string, owner: Owner) => {
  const where = ownerWhere(id, owner);
  const conversation = where
    ? await prisma.assistantConversation.findFirst({ where })
    : null;

  if (!conversation) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Conversation not found");
  }

  return conversation;
};

const createConversation = async (
  owner: Owner,
  locale?: string,
  action?: AssistantAction,
  label?: string,
) => {
  const state: AssistantState = { step: "greeting" };

  const conversation = await prisma.assistantConversation.create({
    data: {
      userId: owner.userId ?? null,
      // A signed-in owner needs no guest key; handing one out would be a second
      // way into the same chat.
      anonymousId: owner.userId ? null : (owner.anonymousId ?? null),
      locale: locale ?? "en",
      state: state as unknown as Prisma.InputJsonValue,
      expiresAt: expiry(Boolean(owner.userId)),
    },
  });

  // Opening the chat and tapping the first button is one round trip: the widget
  // should not have to ask twice before it can draw anything.
  const turn = action
    ? await runTurn(conversation.id, owner, action, label, true)
    : null;

  return {
    conversationId: conversation.id,
    anonymousId: conversation.anonymousId,
    locale: conversation.locale,
    state: turn?.state ?? state,
    messages: turn?.messages ?? [],
    createdAt: conversation.createdAt,
  };
};

const getConversation = async (id: string, owner: Owner) => {
  const owned = await findOwned(id, owner);

  const messages = await prisma.assistantMessage.findMany({
    where: { conversationId: owned.id },
    orderBy: { createdAt: "asc" },
  });

  return { ...owned, state: readState(owned.state), messages };
};

/**
 * One turn: load, dispatch, persist both messages and the new state in a single
 * transaction. The transcript is kept server-side so the chat can be reopened
 * on another device, and so what a customer was shown can be audited later.
 */
const runTurn = async (
  id: string,
  owner: Owner,
  action: AssistantAction,
  label?: string,
  opening = false,
) => {
  const conversation = await findOwned(id, owner);

  if (conversation.status !== "ACTIVE") {
    throw new ApiError(
      StatusCodes.CONFLICT,
      "This conversation is closed. Start a new chat.",
    );
  }

  const state = readState(conversation.state);

  // At the limit, answer but change nothing: the draft stays exactly as it was
  // in case they want to read it, and the counter stops climbing.
  if (conversation.turnCount >= MAX_TURNS) {
    logUnrecorded({
      cid: conversation.id,
      turn: conversation.turnCount,
      step: state.step,
      action: action.type,
      outcome: "blocked",
    });
    return {
      conversationId: conversation.id,
      state,
      messages: [
        {
          id: randomUUID(),
          role: "ASSISTANT" as const,
          text: COPY.turnLimit,
          blocks: [notice("warn", COPY.turnLimit)],
          createdAt: new Date(),
        },
      ],
    };
  }

  const started = Date.now();
  // The caller's own id, not the conversation's: a guest who signs in mid-chat
  // still owns the chat by its key, but the wallet quoted has to be theirs.
  const result = await runAction(state, action, {
    userId: owner.userId,
    conversationId: conversation.id,
    opening,
  });
  const latencyMs = Date.now() - started;

  return recordTurn(conversation.id, {
    action,
    label,
    result,
    latencyMs,
    step: state.step,
    signedIn: Boolean(owner.userId || conversation.userId),
  });
};

/**
 * A typed message: the same turn envelope as a tap, plus `mode` ("guided"
 * when no model was involved) and `toolLabel` when a tool ran. The customer's
 * text is the user message; the action stored beside it is `{ type: "text" }`
 * so the transcript still says how the turn was driven.
 */
const runTextTurn = async (id: string, owner: Owner, text: string) => {
  const conversation = await findOwned(id, owner);

  if (conversation.status !== "ACTIVE") {
    throw new ApiError(
      StatusCodes.CONFLICT,
      "This conversation is closed. Start a new chat.",
    );
  }

  const state = readState(conversation.state);

  if (conversation.turnCount >= MAX_TURNS) {
    logUnrecorded({
      cid: conversation.id,
      turn: conversation.turnCount,
      step: state.step,
      action: "text",
      outcome: "blocked",
    });
    return {
      conversationId: conversation.id,
      state,
      mode: "guided" as const,
      messages: [
        {
          id: randomUUID(),
          role: "ASSISTANT" as const,
          text: COPY.turnLimit,
          blocks: [notice("warn", COPY.turnLimit)],
          createdAt: new Date(),
        },
      ],
    };
  }

  // Text only, oldest first: the model sees what was said, never the blocks,
  // tokens or ids that were on screen.
  const recent = await prisma.assistantMessage.findMany({
    where: { conversationId: conversation.id, text: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { role: true, text: true },
  });
  const history = recent
    .reverse()
    .filter((m) => m.role !== "TOOL")
    .map((m) => ({
      role: m.role === "USER" ? ("user" as const) : ("model" as const),
      text: m.text as string,
    }));

  const started = Date.now();
  const { result, meta } = await textTurn(
    state,
    text,
    { userId: owner.userId, conversationId: conversation.id },
    history,
  );

  const recorded = await recordTurn(conversation.id, {
    action: { type: "text" },
    label: text,
    result,
    latencyMs: Date.now() - started,
    model: meta,
    step: state.step,
    signedIn: Boolean(owner.userId || conversation.userId),
  });

  return {
    ...recorded,
    mode: meta.mode,
    ...(meta.toolLabel ? { toolLabel: meta.toolLabel } : {}),
  };
};

/**
 * Both halves of one turn plus the new state, in a single transaction. Pulled
 * out of `runTurn` so the confirm endpoint — which does not go through
 * `runAction`, because a booking is not a chat action a stale tab may replay —
 * lands in the transcript identically.
 */
export const recordTurn = async (
  conversationId: string,
  input: {
    action: AssistantAction | { type: string };
    label?: string;
    result: { text: string; blocks: unknown[]; state: AssistantState };
    /** Picks the retention: 90 days for a signed-in customer, 30 for a guest. */
    signedIn: boolean;
    latencyMs?: number;
    /** A typed turn: how it was answered, and — when it reached the model —
     *  which one, the tools it ran and what it cost. */
    model?: {
      mode?: "guided" | "ai";
      model?: string;
      promptVersion?: string;
      tokensIn?: number;
      tokensOut?: number;
      tools?: string[];
    };
    /** Set when the turn is what produced the booking. */
    conversation?: { status?: string; appointmentId?: string };
    /** Where the turn started, for the log line. */
    step?: string;
    /** When the blocks alone do not say it — a confirm refused for want of
     *  funds, say. Otherwise read off the notices the turn drew. */
    outcome?: TurnOutcome;
  },
) => {
  const outcome = input.outcome ?? outcomeOf(input.result.blocks);

  const [userMessage, assistantMessage, conversation] = await prisma.$transaction([
    prisma.assistantMessage.create({
      data: {
        conversationId,
        role: "USER",
        text: input.label ?? null,
        action: input.action as unknown as Prisma.InputJsonValue,
      },
    }),
    prisma.assistantMessage.create({
      data: {
        conversationId,
        role: "ASSISTANT",
        text: input.result.text,
        blocks: input.result.blocks as unknown as Prisma.InputJsonValue,
        outcome,
        ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
        ...(input.model?.model
          ? {
              model: input.model.model,
              promptVersion: input.model.promptVersion ?? null,
              tokensIn: input.model.tokensIn ?? null,
              tokensOut: input.model.tokensOut ?? null,
            }
          : {}),
      },
    }),
    prisma.assistantConversation.update({
      where: { id: conversationId },
      data: {
        state: input.result.state as unknown as Prisma.InputJsonValue,
        turnCount: { increment: 1 },
        expiresAt: expiry(input.signedIn),
        ...(input.conversation?.status
          ? { status: input.conversation.status }
          : {}),
        ...(input.conversation?.appointmentId
          ? { appointmentId: input.conversation.appointmentId }
          : {}),
      },
    }),
  ]);

  logTurn({
    cid: conversationId,
    turn: conversation.turnCount,
    step: input.step,
    action: input.action.type,
    mode: input.model?.mode ?? "guided",
    tools: input.model?.tools,
    model: input.model?.model ?? null,
    tokensIn: input.model?.tokensIn,
    tokensOut: input.model?.tokensOut,
    ms: input.latencyMs,
    outcome,
  });

  return {
    conversationId,
    state: input.result.state,
    messages: [userMessage, assistantMessage],
  };
};

/**
 * 👍 / 👎 on one assistant message. Only the conversation's owner may rate it,
 * only an assistant message can be rated, and a second tap overwrites the
 * first — it is an opinion, not a vote count. Phase 8 reviews the 👎 turns.
 */
const rateMessage = async (
  messageId: string,
  owner: Owner,
  value: 1 | -1,
  reason?: string,
) => {
  const message = await prisma.assistantMessage.findUnique({
    where: { id: messageId },
    select: { id: true, conversationId: true, role: true },
  });

  if (!message || message.role !== "ASSISTANT") {
    throw new ApiError(StatusCodes.NOT_FOUND, "Message not found");
  }

  // Someone else's message reads exactly like one that does not exist.
  await findOwned(message.conversationId, owner).catch(() => {
    throw new ApiError(StatusCodes.NOT_FOUND, "Message not found");
  });

  const updated = await prisma.assistantMessage.update({
    where: { id: message.id },
    data: { feedback: value, feedbackReason: reason || null },
    select: { id: true, feedback: true, feedbackReason: true },
  });

  return updated;
};

/**
 * "Delete my chats": every conversation the signed-in caller owns, plus the
 * guest chat on this device they still hold the key to, and by cascade every
 * message in them. Bookings are untouched — they live in `appointments`, and
 * nothing there points back at a conversation.
 */
const deleteMyConversations = async (userId: string, anonymousId?: string) => {
  // `userId: undefined` is no filter at all to Prisma: it would match every
  // conversation there is. The route is behind auth(), but this is the line
  // that makes that a fact rather than an assumption.
  if (!userId) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, "Sign in to delete your chats.");
  }

  const { count } = await prisma.assistantConversation.deleteMany({
    where: {
      OR: [
        { userId },
        ...(anonymousId ? [{ anonymousId, userId: null }] : []),
      ],
    },
  });

  return { deleted: count };
};

/**
 * The retention job. `expiresAt` is written on every turn, so this only has to
 * delete; messages cascade with their conversation, so one delete is enough.
 * A conversation that booked only ever held the appointment's id — the booking
 * itself is in `appointments` and is not touched.
 */
export const purgeExpiredConversations = async (now = new Date()) => {
  const { count } = await prisma.assistantConversation.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return count;
};

export const AssistantService = {
  deleteMyConversations,
  rateMessage,
  createConversation,
  getConversation,
  runTurn,
  runTextTurn,
};
