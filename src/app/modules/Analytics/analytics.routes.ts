import express, { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { clientIp, eventsLimiter } from "../../middlewares/rateLimiter";
import { ingestEvents } from "./analytics.intake";

/** /events - public, cookieless event intake (see analytics.intake.ts). */
const router = express.Router();

router.post(
  "/",
  eventsLimiter,
  catchAsync(async (req: Request, res: Response) => {
    const optedOut = req.get("sec-gpc") === "1" || req.get("dnt") === "1";
    let data = { accepted: 0, rejected: 0, skipped: true };
    try {
      data = await ingestEvents({
        body: req.body,
        ip: clientIp(req),
        userAgent: req.get("user-agent") ?? "",
        optedOut,
      });
    } catch (err) {
      // Counting must never surface as an error to a page.
      console.error("[analytics] events intake failed", err);
    }
    sendResponse(res, { statusCode: StatusCodes.ACCEPTED, success: true, message: "Recorded", data });
  }),
);

export const AnalyticsRoutes = router;
