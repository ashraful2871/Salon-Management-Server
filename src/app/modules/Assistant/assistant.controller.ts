import { randomUUID } from "crypto";
import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import {
  AssistantConfirm,
  AssistantConfirmError,
} from "./assistant.confirm";
import { AssistantService, Owner, recordTurn } from "./assistant.service";

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

const create = catchAsync(async (req: Request, res: Response) => {
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

const act = catchAsync(async (req: Request, res: Response) => {
  const result = await AssistantService.runTurn(
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
 * The one endpoint that books. `Idempotency-Key` is required, not optional: a
 * Confirm without one cannot be made safe to retry, and a booking that might
 * happen twice is worse than a 400.
 */
const confirm = catchAsync(async (req: Request, res: Response) => {
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
    }).catch(() => {
      // The customer still gets the blocks; losing one transcript row is not
      // worth turning a recoverable 409 into a 500.
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

export const AssistantController = { create, get, act, confirm };
