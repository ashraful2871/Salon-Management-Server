import express, { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import { adminSensitiveLimiter } from "../../../middlewares/rateLimiter";
import { adminAuth, adminOnly, requireStepUp } from "../admin.middleware";
import { AdminSystemService } from "./system.service";

/**
 * /admin/system — System health. Reads need system.view; "Run now" is tier 3
 * (system.operate + step-up) and only for jobs marked safeToRunNow. The AI
 * index card reuses GET /ai/status and POST /ai/backfill.
 */
const router = express.Router();

const ok = (res: Response, message: string, data: unknown) =>
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message, data });

router.get(
  "/jobs",
  adminAuth("system.view"),
  adminOnly,
  catchAsync(async (_req: Request, res: Response) => {
    ok(res, "Background jobs", await AdminSystemService.listJobs());
  }),
);

router.post(
  "/jobs/:name/run",
  adminAuth("system.operate"),
  adminOnly,
  adminSensitiveLimiter,
  requireStepUp(),
  catchAsync(async (req: Request, res: Response) => {
    const data = await AdminSystemService.runJobNow(req.auditCtx, req.params.name);
    const message =
      data.status === "SKIPPED"
        ? "Already running, so this run was skipped"
        : data.status === "RUNNING"
          ? "Started; still running"
          : data.status === "FAILED"
            ? "The job ran and failed"
            : "The job ran";
    ok(res, message, data);
  }),
);

router.get(
  "/integrations",
  adminAuth("system.view"),
  adminOnly,
  catchAsync(async (_req: Request, res: Response) => {
    ok(res, "Integrations", await AdminSystemService.integrations());
  }),
);

router.get(
  "/storage",
  adminAuth("system.view"),
  adminOnly,
  catchAsync(async (_req: Request, res: Response) => {
    ok(res, "Storage", await AdminSystemService.storage());
  }),
);

export const AdminSystemRoutes = router;
