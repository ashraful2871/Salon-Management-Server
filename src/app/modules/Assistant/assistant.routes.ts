import express, { NextFunction, Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { UserRole } from "@prisma/client";
import auth from "../../middlewares/auth";
import optionalAuth from "../../middlewares/optionalAuth";
import {
  assistantLimiter,
  assistantLlmLimiter,
  assistantStartLimiter,
  paymentLimiter,
} from "../../middlewares/rateLimiter";
import validateRequest from "../../middlewares/validateRequest";
import { AssistantController } from "./assistant.controller";
import { ASSISTANT_ENABLED } from "./assistant.constants";
import { AssistantValidation } from "./assistant.validation";

const router = express.Router();

/** The kill switch. Off, the whole surface is simply not there. */
const assistantEnabled = (req: Request, res: Response, next: NextFunction) => {
  if (!ASSISTANT_ENABLED) {
    return res.status(StatusCodes.NOT_FOUND).json({
      success: false,
      message: "Not found",
    });
  }
  next();
};

router.use(assistantEnabled);

/**
 * Every body here is replaced by its parsed form: keys the schema does not name
 * are stripped before a handler — or the transcript, which stores the action —
 * ever sees them.
 */
const validated: typeof validateRequest = (schema) =>
  validateRequest(schema, { replaceBody: true });

/**
 * Whether to draw the launcher, and which privacy line to show. Public and
 * free (no database), so it has no limiter; the frontend caches it for a
 * minute. With the kill switch off it 404s like every other route here, which
 * is what hides the launcher.
 */
router.get("/status", AssistantController.status);

// optionalAuth runs before the limiter, as in ai.route.ts: every call reaches
// us from the Next.js server, so without it each visitor would share one bucket.
router.post(
  "/conversations",
  optionalAuth(),
  assistantLimiter,
  assistantStartLimiter,
  validated(AssistantValidation.createConversation),
  AssistantController.create,
);

/**
 * "Delete my chats". Signed-in only: a guest's chat is reachable only through
 * the key on this device and expires on its own after 30 days.
 */
router.delete(
  "/conversations",
  auth(UserRole.CUSTOMER, UserRole.SALON_OWNER, UserRole.ADMIN),
  assistantLimiter,
  AssistantController.deleteMine,
);

router.get(
  "/conversations/:id",
  optionalAuth(),
  assistantLimiter,
  AssistantController.get,
);

router.post(
  "/conversations/:id/actions",
  optionalAuth(),
  assistantLimiter,
  validated(AssistantValidation.runAction),
  AssistantController.act,
);

/** Free text. The only assistant route that can reach the model; a tap never
 *  does. Same turn envelope as /actions. */
router.post(
  "/conversations/:id/messages",
  optionalAuth(),
  assistantLlmLimiter,
  validated(AssistantValidation.sendMessage),
  AssistantController.message,
);

/**
 * The only endpoint here that writes a booking, so it is the only one behind
 * `auth` rather than `optionalAuth`: a guest has no wallet to take a deposit
 * from. The role set matches the one `bookAppointment` itself accepts.
 */
router.post(
  "/bookings/confirm",
  auth(UserRole.CUSTOMER, UserRole.SALON_OWNER, UserRole.ADMIN),
  assistantLimiter,
  validated(AssistantValidation.confirmBooking),
  AssistantController.confirm,
);

/**
 * Opens a wallet top-up from the chat — the same `initiateTopup` the wallet
 * page uses — so it takes the wallet's own `paymentLimiter`, after `auth` so
 * the bucket is the account and not the Vercel server every call arrives from.
 */
router.post(
  "/payments/topup",
  auth(UserRole.CUSTOMER, UserRole.SALON_OWNER, UserRole.ADMIN),
  paymentLimiter,
  validated(AssistantValidation.startTopup),
  AssistantController.topup,
);

/** 👍 / 👎 on one assistant message — the cheapest quality signal there is.
 *  Guests may rate their own chat too, by the same key that owns it. */
router.post(
  "/messages/:id/feedback",
  optionalAuth(),
  assistantLimiter,
  validated(AssistantValidation.messageFeedback),
  AssistantController.feedback,
);

/** Launch numbers: per-day counts, the funnel, the top problems. No
 *  transcripts, ADMIN only. */
router.get("/stats", auth(UserRole.ADMIN), AssistantController.stats);

export const AssistantRoutes = router;
