import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { AssistantAction, runAction } from "./assistant.actions";
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
const findOwned = async (id: string, owner: Owner) => {
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
    ? await runTurn(conversation.id, owner, action, label)
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
  const result = await runAction(state, action);
  const latencyMs = Date.now() - started;

  const [userMessage, assistantMessage] = await prisma.$transaction([
    prisma.assistantMessage.create({
      data: {
        conversationId: conversation.id,
        role: "USER",
        text: label ?? null,
        action: action as unknown as Prisma.InputJsonValue,
      },
    }),
    prisma.assistantMessage.create({
      data: {
        conversationId: conversation.id,
        role: "ASSISTANT",
        text: result.text,
        blocks: result.blocks as unknown as Prisma.InputJsonValue,
        latencyMs,
      },
    }),
    prisma.assistantConversation.update({
      where: { id: conversation.id },
      data: {
        state: result.state as unknown as Prisma.InputJsonValue,
        turnCount: { increment: 1 },
        expiresAt: expiry(),
      },
    }),
  ]);

  return {
    conversationId: conversation.id,
    state: result.state,
    messages: [userMessage, assistantMessage],
  };
};

export const AssistantService = {
  createConversation,
  getConversation,
  runTurn,
};
