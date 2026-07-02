import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { AgentService } from "./agent.service";

const createAgent = catchAsync(async (req: Request, res: Response) => {
  const result = await AgentService.createAgent(req.body);

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: "Agent created successfully",
    data: result,
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
