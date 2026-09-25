import express from "express";
import { aiController } from "./ai.controller";
import auth from "../../middlewares/auth";
import optionalAuth from "../../middlewares/optionalAuth";
import validateRequest from "../../middlewares/validateRequest";
import { aiSearchLimiter } from "../../middlewares/rateLimiter";
import { AiValidation } from "./ai.validation";

const router = express.Router();

// Public, and spends Gemini quota. optionalAuth runs first so the limiter can
// count a signed-in customer by account instead of by the shared server IP.
router.post(
  "/search",
  optionalAuth(),
  aiSearchLimiter,
  validateRequest(AiValidation.searchValidation),
  aiController.search,
);

router.get("/status", auth("ADMIN"), aiController.indexStatus);

// Both of these spend quota per salon.
router.post(
  "/generate/:id",
  auth("ADMIN", "SALON_OWNER"),
  aiController.generateEmbedding,
);

router.post("/backfill", auth("ADMIN"), aiController.backfillEmbeddings);

export const AiRoutes = router;
