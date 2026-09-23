import { z } from "zod";
import { formatBDT } from "../../utils/money";
import { PaymentIntentService } from "../Payment/paymentIntent.service";
import type { AssistantAction } from "./assistant.actions";

/**
 * A discriminated union is what makes an unknown `type` a 400 at the edge
 * instead of a surprise inside a handler.
 */
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start") }),
  z.object({
    type: z.literal("find_nearby"),
    page: z.coerce.number().int().min(1).max(50).optional(),
  }),
  z.object({
    type: z.literal("set_location"),
    lat: z.number(),
    lng: z.number(),
    label: z.string().max(80).optional(),
  }),
  z.object({
    type: z.literal("search_salons"),
    query: z.string().max(300),
    page: z.coerce.number().int().min(1).max(50).optional(),
  }),
  z.object({ type: z.literal("choose_salon"), salonId: z.string().uuid() }),
  z.object({ type: z.literal("change_location") }),
  z.object({ type: z.literal("book") }),
  z.object({ type: z.literal("show_services") }),
  z.object({
    type: z.literal("choose_date"),
    // The calendar day, not an instant: slots are stored per day.
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  z.object({ type: z.literal("choose_service"), serviceId: z.string().uuid() }),
  z.object({ type: z.literal("choose_counter"), counterId: z.string().uuid() }),
  z.object({ type: z.literal("choose_slot"), slotId: z.string().uuid() }),
  z.object({
    type: z.literal("change"),
    target: z.enum(["salon", "date", "service", "counter", "slot"]),
  }),
  z.object({ type: z.literal("wallet") }),
  z.object({ type: z.literal("check_payment") }),
  z.object({ type: z.literal("restart") }),
  z.object({ type: z.literal("back") }),
]);

// Fails the build if the schema and the handler union ever drift apart.
type ParsedAction = z.infer<typeof actionSchema>;
const _actionsMatch: ParsedAction extends AssistantAction ? true : never = true;
void _actionsMatch;

const createConversation = z.object({
  body: z.object({
    locale: z.enum(["en", "bn"]).optional(),
    action: actionSchema.optional(),
    label: z.string().max(80).optional(),
  }),
});

const runAction = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    action: actionSchema,
    label: z.string().max(80).optional(),
  }),
});

/**
 * The token is opaque here on purpose: it is verified by its HMAC in
 * `assistant.token.ts`, not by its shape. All zod has to do is keep a
 * megabyte of nonsense out of the crypto.
 */
const confirmBooking = z.object({
  body: z.object({
    confirmationToken: z.string().min(1).max(2048),
    notes: z.string().max(500).optional(),
  }),
});

/**
 * Poisha, like every other `*Minor` field the chat speaks. The wallet's own
 * route takes taka and converts at its boundary; this one already has the
 * figure the prompt offered, so it only has to be a whole number in range.
 */
const startTopup = z.object({
  body: z.object({
    conversationId: z.string().uuid(),
    amountMinor: z
      .number()
      .int("Top-ups are in whole poisha.")
      .min(
        PaymentIntentService.MIN_TOPUP_MINOR,
        `Minimum top-up is ${formatBDT(PaymentIntentService.MIN_TOPUP_MINOR)}`,
      )
      .max(
        PaymentIntentService.MAX_TOPUP_MINOR,
        `Maximum top-up is ${formatBDT(PaymentIntentService.MAX_TOPUP_MINOR)}`,
      ),
    autoConfirm: z.boolean().optional(),
    label: z.string().max(80).optional(),
  }),
});

export const AssistantValidation = {
  actionSchema,
  createConversation,
  runAction,
  confirmBooking,
  startTopup,
};
