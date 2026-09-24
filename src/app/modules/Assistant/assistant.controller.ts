import { randomUUID } from "crypto";
import { Request, RequestHandler, Response } from "express";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import {
  AssistantConfirm,
  AssistantConfirmError,
} from "./assistant.confirm";
import { ASSISTANT_LLM_ENABLED, COPY } from "./assistant.constants";
import { failureOutcome, logUnrecorded } from "./assistant.log";
import { isPaymentQuestion } from "./assistant.nlu";
import { AssistantPayment } from "./assistant.payment";
import { AssistantService, Owner, recordTurn } from "./assistant.service";
import { AssistantStats } from "./assistant.stats";

/**
 * The guest key travels in a header, not a cookie: a Set-Cookie from the API
 * host does not stick on the frontend's domain, so the Next.js server stores it
 * and sends it back on every turn.
 */
const ownerOf = (req: Request): Owner => ({
  ...(req.user?.userId ? { userId: req.user.userId } : {}),
  ...(req.get("x-assistant-key")
    ? { anonymousId: req.get("x-assistant-key") }
    : {}),
});

/**
 * A turn that throws never reaches `recordTurn`, so it would leave no log line
 * at all — and a turn nobody can see is exactly the one worth finding. `name`
 * is the action type when the body does not carry one.
 */
const turnHandler = (name: string, fn: RequestHandler) =>
  catchAsync(async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (error) {
      logUnrecorded({
        cid: req.params.id ?? req.body?.conversationId ?? null,
        action: req.body?.action?.type ?? name,
        outcome: failureOutcome(error),
      });
      throw error;
    }
  });

const create = turnHandler("start", async (req: Request, res: Response) => {
  const owner: Owner = req.user?.userId
    ? { userId: req.user.userId }
    : { anonymousId: randomUUID() };

  const result = await AssistantService.createConversation(
    owner,
    req.body.locale,
    req.body.action,
    req.body.label,
  );

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: "Conversation started",
    data: result,
  });
});

const get = catchAsync(async (req: Request, res: Response) => {
  const result = await AssistantService.getConversation(
    req.params.id,
    ownerOf(req),
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Conversation retrieved",
    data: result,
  });
});

const act = turnHandler("action", async (req: Request, res: Response) => {
  // "Has my top-up landed?" can end in a booking, so it goes to the payment
  // module — which owns the lock and the confirm — rather than the funnel.
  const result =
    req.body.action?.type === "check_payment"
      ? await AssistantPayment.checkPayment(
          req.params.id,
          ownerOf(req),
          req.body.label,
        )
      : await AssistantService.runTurn(
          req.params.id,
          ownerOf(req),
          req.body.action,
          req.body.label,
        );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Action handled",
    data: result,
  });
});

/**
 * A typed message. "Did my payment go through?" goes where the tap would, the
 * payment module; everything else is a text turn.
 */
const message = turnHandler("text", async (req: Request, res: Response) => {
  const text: string = req.body.text;
  const result = isPaymentQuestion(text)
    ? {
        ...(await AssistantPayment.checkPayment(req.params.id, ownerOf(req), text.slice(0, 80))),
        mode: "guided" as const,
      }
    : await AssistantService.runTextTurn(req.params.id, ownerOf(req), text);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Message handled",
    data: result,
  });
});

/**
 * The one endpoint that books. `Idempotency-Key` is required, not optional: a
 * Confirm without one cannot be made safe to retry, and a booking that might
 * happen twice is worse than a 400.
 */
const confirm = turnHandler("confirm_booking", async (req: Request, res: Response) => {
  const idempotencyKey = req.get("idempotency-key")?.trim();

  if (!idempotencyKey) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "An Idempotency-Key header is required to confirm a booking.",
    );
  }

  try {
    const result = await AssistantConfirm.confirmBooking({
      confirmationToken: req.body.confirmationToken,
      idempotencyKey,
      notes: req.body.notes,
      owner: ownerOf(req),
      userId: req.user!.userId,
    });

    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: result.replayed
        ? "This booking was already confirmed"
        : "Booking confirmed",
      data: {
        conversationId: result.conversationId,
        appointment: result.appointment,
        state: result.turn.state,
        blocks: result.turn.blocks,
        text: result.turn.text,
      },
    });
  } catch (error) {
    // A failure the chat can draw: answer with the mapped status and the
    // blocks, and put the same turn in the transcript so a reload agrees with
    // what the customer is looking at.
    if (!(error instanceof AssistantConfirmError)) throw error;

    await recordTurn(error.conversationId, {
      action: { type: "confirm_booking" },
      label: "Confirm booking",
      result: error.turn,
      signedIn: true,
      outcome: error.outcome,
    }).catch(() => {
      // The customer still gets the blocks; losing one transcript row is not
      // worth turning a recoverable 409 into a 500. The line still gets logged.
      logUnrecorded({
        cid: error.conversationId,
        action: "confirm_booking",
        outcome: error.outcome,
      });
    });

    sendResponse(res, {
      statusCode: error.statusCode,
      success: false,
      message: error.turn.text,
      data: {
        conversationId: error.conversationId,
        state: error.turn.state,
        blocks: error.turn.blocks,
        text: error.turn.text,
      },
    });
  }
});

/**
 * Opens a wallet top-up from the chat. 201 with the gateway URL; or, when "Top
 * up & book" finds the time no longer held, 409 with a turn to draw (what is
 * free instead) and no payment started.
 */
const topup = turnHandler("start_topup", async (req: Request, res: Response) => {
  const result = await AssistantPayment.startTopup({
    conversationId: req.body.conversationId,
    owner: ownerOf(req),
    userId: req.user!.userId,
    amountMinor: req.body.amountMinor,
    autoConfirm: req.body.autoConfirm ?? false,
    label: req.body.label,
  });

  sendResponse(res, {
    statusCode: result.started ? StatusCodes.CREATED : StatusCodes.CONFLICT,
    success: result.started,
    message: result.started
      ? "Top-up session created. Redirect the customer to complete it."
      : COPY.topupNotHeld,
    data: result,
  });
});

/** 👍 / 👎 on an assistant message. */
const feedback = catchAsync(async (req: Request, res: Response) => {
  const result = await AssistantService.rateMessage(
    req.params.id,
    ownerOf(req),
    req.body.value,
    req.body.reason,
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Thanks for the feedback",
    data: result,
  });
});

/** "Delete my chats". The caller's own conversations only — see the service. */
const deleteMine = catchAsync(async (req: Request, res: Response) => {
  const result = await AssistantService.deleteMyConversations(
    req.user!.userId,
    req.get("x-assistant-key") ?? undefined,
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message:
      result.deleted === 1
        ? "1 chat deleted"
        : `${result.deleted} chats deleted`,
    data: result,
  });
});

/** Launch numbers for ADMIN: per-day counts, the funnel, the top problems. */
const stats = catchAsync(async (_req: Request, res: Response) => {
  const result = await AssistantStats.getStats();

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Assistant stats retrieved",
    data: result,
  });
});

/**
 * What the frontend needs to decide whether to draw the launcher and which
 * privacy line to show. Reaching this handler at all means the assistant is on:
 * with `ASSISTANT_ENABLED=false` the router answers 404 before it gets here.
 */
const status = (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Assistant is on",
    data: { enabled: true, llm: ASSISTANT_LLM_ENABLED },
  });
};

export const AssistantController = {
  create,
  get,
  act,
  message,
  confirm,
  topup,
  feedback,
  deleteMine,
  stats,
  status,
};
