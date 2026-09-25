import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import config from "../../../config";
import ApiError from "../../Error/error";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { ownedSalonIds } from "../../utils/salonAccess";
import { isGeminiConfigured } from "./ai.gemini";
import { aiService } from "./ai.service";
import { AiValidation } from "./ai.validation";

const search = catchAsync(async (req: Request, res: Response) => {
  // validateRequest checked the body; parse again for the trimmed, coerced values.
  const body = AiValidation.searchBody.parse(req.body);

  const result = await aiService.searchSalon(body);
  const count = result.salons.length;

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: count
      ? `Found ${count} matching salon${count === 1 ? "" : "s"}`
      : "No matching salons found",
    data: result,
  });
});

/** How much of the catalogue AI search can see. For admins and monitoring. */
const indexStatus = catchAsync(async (_req: Request, res: Response) => {
  const coverage = await aiService.indexCoverage();

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: `${coverage.upToDate} of ${coverage.activeSalons} active salons are indexed and up to date`,
    data: {
      ...coverage,
      geminiConfigured: isGeminiConfigured(),
      chatModels: config.ai.chatModels,
    },
  });
});

const INDEX_MESSAGES = {
  embedded: "Salon re-indexed for AI search",
  unchanged: "Nothing changed since the last indexing",
  skipped: "Only active salons are indexed; this one will be once it is approved",
} as const;

const generateEmbedding = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params;
  const isAdmin = req.user?.role === "ADMIN";

  if (!isAdmin && !(await ownedSalonIds(req.user?.userId)).includes(id)) {
    throw new ApiError(StatusCodes.FORBIDDEN, "You can only re-index your own salons");
  }

  // Owners get the cheap path: an unchanged salon costs no Gemini call.
  const outcome = await aiService.indexSalon(id, { force: isAdmin });

  if (outcome === "missing") {
    throw new ApiError(StatusCodes.NOT_FOUND, "Salon not found");
  }
  if (outcome === "unconfigured") {
    throw new ApiError(
      StatusCodes.SERVICE_UNAVAILABLE,
      "GEMINI_API_KEY is not configured - AI search is unavailable",
    );
  }

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: INDEX_MESSAGES[outcome],
    data: { salonId: id, outcome },
  });
});

const backfillEmbeddings = catchAsync(async (req: Request, res: Response) => {
  // ?all=true re-embeds every active salon even when nothing changed.
  const force = req.query.all === "true";

  const result = await aiService.reindexAll({ force });

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: `Embedded ${result.embedded}, unchanged ${result.unchanged}, failed ${result.failed} of ${result.total} active salons`,
    data: result,
  });
});

export const aiController = {
  search,
  indexStatus,
  generateEmbedding,
  backfillEmbeddings,
};
