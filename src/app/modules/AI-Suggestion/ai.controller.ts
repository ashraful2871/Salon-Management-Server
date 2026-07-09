import catchAsync from "../../shared/catchAsync";
import { aiService } from "./ai.service";
import httpStatus from "http-status";
import { Request, Response } from "express";
import sendResponse from "../../shared/sendResponse";

const search = catchAsync(async (req: Request, res: Response) => {
  const { prompt } = req.body;

  const result = await aiService.searchSalon(prompt as string);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "AI Suggestions retrieved successfully",
    data: result,
  });
});

const generateEmbedding = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params; // Get salon ID from the URL

  const result = await aiService.generateAndSaveSaloneEmbedding(id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Embedding generated successfully",
    data: result,
  });
});

// Update your export at the bottom!
export const aiController = { search, generateEmbedding };
