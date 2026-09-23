import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { AssistantAction, runAction } from "./assistant.actions";
import { textTurn } from "./assistant.ai";
import { notice } from "./assistant.blocks";
import { COPY, CONVERSATION_TTL_DAYS, MAX_TURNS } from "./assistant.constants";
import { AssistantState, readState } from "./assistant.state";

/** Signed in → the account owns it. Guest → the `anonymousId` we handed back on
 *  create does, carried in `X-Assistant-Key`. */
export type Owner = { userId?: string; anonymousId?: string };

const expiry = () =>
  new Date(Date.now() + CONVERSATION_TTL_DAYS * 24 * 60 * 60 * 1000);

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
      expiresAt: expiry(),
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
    latencyMs?: number;
    /** A typed turn that reached the model: which one, and what it cost. */
    model?: { model?: string; promptVersion?: string; tokensIn?: number; tokensOut?: number };
    /** Set when the turn is what produced the booking. */
    conversation?: { status?: string; appointmentId?: string };
  },
) => {
  const [userMessage, assistantMessage] = await prisma.$transaction([
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
        expiresAt: expiry(),
        ...(input.conversation?.status
          ? { status: input.conversation.status }
          : {}),
        ...(input.conversation?.appointmentId
          ? { appointmentId: input.conversation.appointmentId }
          : {}),
      },
    }),
  ]);

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

export const AssistantService = {
  rateMessage,
  createConversation,
  getConversation,
  runTurn,
  runTextTurn,
};
