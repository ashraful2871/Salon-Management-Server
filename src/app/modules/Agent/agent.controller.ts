import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { AgentService } from "./agent.service";

// Agents arrive by invitation (POST /admin/agents/invitations); the old
// create-with-a-password endpoint answers 410 so stale clients fail loudly.
const createAgent = catchAsync(async (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: StatusCodes.GONE,
    success: false,
    message: "Agents are invited from the admin panel",
  });
});

const getAllAgents = catchAsync(async (req: Request, res: Response) => {
  const result = await AgentService.getAllAgents(req.query);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Agents retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

export const AgentController = {
  createAgent,
  getAllAgents,
};
