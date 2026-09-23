import { ServiceCategory } from "@prisma/client";
import { z } from "zod";
import { formatBDT } from "../../utils/money";
import { PaymentIntentService } from "../Payment/paymentIntent.service";
import type { AssistantAction } from "./assistant.actions";

/**
 * A typed message, read by the rules (or the model's tool call) into the same
 * filters AI search uses. It rides on the action so "Show more" can page the
 * same search with a tap — re-reading the words would mean a model call.
 */
export const searchFiltersSchema = z.object({
  categories: z.array(z.nativeEnum(ServiceCategory)).max(12).default([]),
  serviceTerms: z.array(z.string().max(60)).max(6).default([]),
  place: z
    .object({
      area: z.string().max(80).optional(),
      district: z.string().max(80).optional(),
      city: z.string().max(80).optional(),
      division: z.string().max(80).optional(),
      label: z.string().max(120),
    })
    .nullable()
    .default(null),
  nearMe: z.boolean().default(false),
  maxPriceMinor: z.number().int().nonnegative().nullable().default(null),
  minPriceMinor: z.number().int().nonnegative().nullable().default(null),
  budget: z.boolean().default(false),
  minRating: z.number().min(0).max(5).nullable().default(null),
  sortBy: z.enum(["relevance", "rating", "price", "distance"]).default("relevance"),
  openNow: z.boolean().default(false),
});

export type SearchFilters = z.infer<typeof searchFiltersSchema>;

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
    filters: searchFiltersSchema.optional(),
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
  z.object({
    type: z.literal("my_bookings"),
    scope: z.enum(["upcoming", "past"]).optional(),
  }),
  z.object({ type: z.literal("cancel_booking"), appointmentId: z.string().uuid() }),
  z.object({ type: z.literal("cancel_confirm"), appointmentId: z.string().uuid() }),
  z.object({ type: z.literal("reschedule"), appointmentId: z.string().uuid() }),
  z.object({ type: z.literal("book_usual"), appointmentId: z.string().uuid() }),
  z.object({
    type: z.literal("rate_booking"),
    appointmentId: z.string().uuid(),
    rating: z.number().int().min(1).max(5),
  }),
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

/** A typed message. Two characters is the shortest thing worth reading
 *  ("ok", "kal"); 300 is a paragraph, and the model is paid per token. */
const sendMessage = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ text: z.string().trim().min(2).max(300) }),
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

/** 👍 / 👎 on one assistant message, with an optional word on why. */
const messageFeedback = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    value: z.union([z.literal(1), z.literal(-1)]),
    reason: z.string().trim().max(300).optional(),
  }),
});

export const AssistantValidation = {
  messageFeedback,
  actionSchema,
  createConversation,
  runAction,
  sendMessage,
  confirmBooking,
  startTopup,
};
