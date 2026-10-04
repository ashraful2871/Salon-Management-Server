import express from "express";
import validateRequest from "../../middlewares/validateRequest";
import {
  hairGenerateDayLimiter,
  hairGenerateHourLimiter,
  hairUploadLimiter,
} from "../../middlewares/rateLimiter";
import { HairTryOnController } from "./hairTryOn.controller";
import { HairTryOnValidation } from "./hairTryOn.validation";

const router = express.Router();

// All public: an upload belongs to whoever holds the X-Tryon-Token issued with it.
router.get("/styles", HairTryOnController.getStyles);

router.post(
  "/uploads",
  hairUploadLimiter,
  validateRequest(HairTryOnValidation.createUpload),
  HairTryOnController.createUpload,
);

router.post(
  "/uploads/:id/confirm",
  validateRequest(HairTryOnValidation.confirmUpload),
  HairTryOnController.confirmUpload,
);

router.delete(
  "/uploads/:id",
  validateRequest(HairTryOnValidation.deleteUpload),
  HairTryOnController.deleteUpload,
);

// reuseJob answers repeats before the limiters, so only real generations count.
router.post(
  "/jobs",
  validateRequest(HairTryOnValidation.createJob, { replaceBody: true }),
  HairTryOnController.reuseJob,
  hairGenerateHourLimiter,
  hairGenerateDayLimiter,
  HairTryOnController.createJob,
);

router.get(
  "/jobs/:id",
  validateRequest(HairTryOnValidation.getJob),
  HairTryOnController.getJob,
);

export const HairTryOnRoutes = router;
