import { randomUUID } from "crypto";
import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { AssistantService, Owner } from "./assistant.service";

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

export const AssistantController = { create, get, act };
