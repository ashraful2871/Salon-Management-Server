import catchAsync from "../../shared/catchAsync";
import { aiService } from "./ai.service";
import { StatusCodes } from "http-status-codes";
import { Request, Response } from "express";
import sendResponse from "../../shared/sendResponse";

const search = catchAsync(async (req: Request, res: Response) => {
  const { prompt, limit } = req.body;

  const result = await aiService.searchSalon(
    prompt as string,
    limit ? Number(limit) : undefined
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: result.salons.length
      ? `Found ${result.salons.length} matching salon${
          result.salons.length === 1 ? "" : "s"
        }`
      : "No matching salons found",
    data: result,
  });
});

const generateEmbedding = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params;

  const result = await aiService.generateAndSaveSaloneEmbedding(id);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Embedding generated successfully",
    data: result,
  });
});

const backfillEmbeddings = catchAsync(async (req: Request, res: Response) => {
  // ?all=true also regenerates salons that already have a vector, which is what
  // you want after the embedded text changes.
  const onlyMissing = req.query.all !== "true";

  const result = await aiService.backfillEmbeddings(onlyMissing);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: `Embedded ${result.succeeded} of ${result.total} salons`,
    data: result,
  });
});

export const aiController = { search, generateEmbedding, backfillEmbeddings };
