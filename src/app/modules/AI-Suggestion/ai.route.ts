import express from "express";
import { aiController } from "./ai.controller";
import auth from "../../middlewares/auth";
import { aiSearchLimiter } from "../../middlewares/rateLimiter";

const router = express.Router();

// Public, but every call spends Gemini quota on two model requests.
router.post("/search", aiSearchLimiter, aiController.search);

// Both of these spend quota per salon and were open to anonymous callers.
router.post(
  "/generate/:id",
  auth("ADMIN", "SALON_OWNER"),
  aiController.generateEmbedding
);

router.post(
  "/backfill",
  auth("ADMIN"),
  aiController.backfillEmbeddings
);

export const AiRoutes = router;
