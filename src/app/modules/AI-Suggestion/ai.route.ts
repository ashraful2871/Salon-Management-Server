import express from "express";
import { aiController } from "./ai.controller";

const router = express.Router();

router.post("/search", aiController.search);
router.post("/generate/:id", aiController.generateEmbedding);

export const AiRoutes = router;
