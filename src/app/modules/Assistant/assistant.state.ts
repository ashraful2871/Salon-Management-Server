import { z } from "zod";
import type { AssistantAction } from "./assistant.actions";

/**
 * The booking draft. It lives in one JSON column, so it is parsed on every read
 * and write rather than trusted: a state written by an older deploy must never
 * lock a customer out of their own chat.
 */
export const STEPS = [
  "greeting",
  "discover",
  "salon",
  "date",
  "service",
  "counter",
  "slot",
  "summary",
  "payment",
  "booked",
] as const;

export type Step = (typeof STEPS)[number];

export const assistantStateSchema = z.object({
  step: z.enum(STEPS).default("greeting"),
  salonId: z.string().uuid().optional(),
  serviceId: z.string().uuid().optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  counterId: z.string().uuid().optional(),
  slotId: z.string().uuid().optional(),
  staffId: z.string().uuid().optional(),
  location: z
    .object({ lat: z.number(), lng: z.number(), label: z.string().max(80) })
    .optional(),
  lastQuery: z.string().max(300).optional(),
  /**
   * What a typed message asked for that the funnel has not reached yet —
   * "tomorrow evening", "a haircut". Applied once, when the step it answers
   * comes up, and then dropped, so a later "Change day" tap is not overruled
   * by something typed three turns ago.
   */
  wish: z
    .object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      partOfDay: z.enum(["morning", "afternoon", "evening", "night"]).optional(),
      after: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      categories: z.array(z.string().max(20)).max(12).optional(),
      serviceTerms: z.array(z.string().max(60)).max(6).optional(),
      /** A search that needed a location first; re-run once one arrives. */
      search: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  /**
   * The options the last picker showed, so "the first one", "the cheaper one"
   * or "5:45" can be matched without asking the model. Capped: it is a lookup
   * table, not a copy of the block.
   */
  lastOptions: z
    .object({
      kind: z.enum(["salon", "date", "service", "counter", "slot"]),
      items: z
        .array(
          z.object({
            id: z.string().max(40),
            label: z.string().max(120),
            priceMinor: z.number().int().nullable().optional(),
            category: z.string().max(20).optional(),
            time: z.string().max(5).optional(),
          }),
        )
        .max(20),
    })
    .optional(),
  /**
   * The booking this conversation produced, keyed by the `Idempotency-Key`
   * that produced it. A replayed Confirm — a double tap, a retried request —
   * matches the key and is answered with the same appointment instead of a
   * second one. This is the second of the two idempotency guards; the first is
   * the conditional slot claim, which can only ever win once.
   */
  confirm: z
    .object({ key: z.string().max(200), appointmentId: z.string().uuid() })
    .optional(),
  /**
   * The Confirm token the current summary was drawn with. Kept server-side so
   * "Top up & book" can carry the exact quoted figures through the gateway
   * without the client sending them back. Like the block's copy, it never goes
   * into a model prompt.
   */
  quoteToken: z.string().max(2048).optional(),
  /** The hold on this slot has already had its one top-up extension. */
  holdExtended: z.boolean().optional(),
  /**
   * The booking this funnel is moving. Set by "Reschedule"; Confirm then books
   * the new time first and cancels this one only once that succeeded. Dropped
   * with the salon, so walking off to another salon is a new booking, not a
   * move.
   */
  rescheduleOf: z.string().uuid().optional(),
  /**
   * A wallet top-up this chat opened and has not yet seen settle. It rides
   * alongside whatever step the customer is at, rather than being a step: they
   * may keep looking while the gateway page is open. `confirmToken` is present
   * only for "Top up & book" — that tap is the consent to book when the money
   * lands, and nothing else is.
   */
  pendingTopup: z
    .object({
      transactionId: z.string().max(100),
      amountMinor: z.number().int().positive(),
      autoConfirm: z.boolean(),
      confirmToken: z.string().max(2048).optional(),
      /** The gateway page, so a double tap re-opens it instead of starting a
       *  second payment. */
      redirectUrl: z.string().max(2048).optional(),
      startedAt: z.string().max(40),
    })
    .optional(),
});

export type PendingTopup = NonNullable<AssistantState["pendingTopup"]>;

export type AssistantState = z.infer<typeof assistantStateSchema>;

/**
 * Never throws. A state we cannot parse is a state an older deploy wrote, and
 * the customer's way out of that is a fresh greeting, not a 500.
 */
export const readState = (json: unknown): AssistantState => {
  const parsed = assistantStateSchema.safeParse(json ?? {});
  return parsed.success ? parsed.data : { step: "greeting" };
};

type ActionType = AssistantAction["type"];

/**
 * Looking after bookings that already exist. Reachable from every step — "what
 * did I book?" is a fair question in the middle of booking something else, and
 * none of these touch the draft except Reschedule and Book again, which start
 * a new one on purpose.
 */
const MANAGE: ActionType[] = [
  "my_bookings",
  "cancel_booking",
  "cancel_confirm",
  "reschedule",
  "book_usual",
  "rate_booking",
];

/**
 * Accepted everywhere inside the funnel. A customer is always allowed to walk
 * away to another salon, change something they already picked, or start again —
 * a booking flow that traps you is one you abandon.
 */
const ALWAYS: ActionType[] = [
  ...MANAGE,
  "change",
  "restart",
  "back",
  "find_nearby",
  // "Gulshan instead", typed mid-funnel, is another search.
  "search_salons",
  "choose_salon",
  "wallet",
  "check_payment",
];

/** What a tap may do from where the customer actually is. Anything else is a
 *  stale tab pressing an old button — answered, not thrown at. */
export const ALLOWED_ACTIONS: Record<Step, ActionType[]> = {
  greeting: [
    "start",
    "find_nearby",
    "set_location",
    "change_location",
    "search_salons",
    // The deep links ("Ask about this salon", "Continue in chat") open a brand
    // new conversation *and* name a salon, so this arrives before the customer
    // has been anywhere. Without it the first thing they see is "that option is
    // no longer available".
    "choose_salon",
    "restart",
    "wallet",
    "check_payment",
    ...MANAGE,
  ],
  discover: [
    "start",
    "find_nearby",
    "set_location",
    "search_salons",
    "change_location",
    "choose_salon",
    "restart",
    "back",
    "wallet",
    "check_payment",
    ...MANAGE,
  ],
  salon: [
    "find_nearby",
    "set_location",
    "search_salons",
    "choose_salon",
    "change_location",
    "book",
    "show_services",
    "restart",
    "back",
    "wallet",
    "check_payment",
    ...MANAGE,
  ],
  // Date and service may arrive in either order, so each of the two steps
  // accepts both answers — see `nextStep` in assistant.actions.ts.
  date: [...ALWAYS, "book", "show_services", "choose_date", "choose_service"],
  service: [...ALWAYS, "book", "show_services", "choose_service", "choose_date"],
  counter: [
    ...ALWAYS,
    "book",
    "show_services",
    "choose_counter",
    "choose_date",
    "choose_service",
  ],
  slot: [
    ...ALWAYS,
    "book",
    "show_services",
    "choose_slot",
    "choose_counter",
    "choose_date",
    "choose_service",
  ],
  summary: [
    ...ALWAYS,
    "book",
    "show_services",
    "choose_slot",
    "choose_counter",
    "choose_date",
    "choose_service",
  ],
  // Never entered: a top-up rides alongside the step as `pendingTopup`, so the
  // customer is not parked on a screen while the gateway page is open.
  payment: [],
  // A finished booking is not a dead end: the customer may want another salon,
  // their wallet, or to start again. It is deliberately not `change` or
  // `choose_slot` — the appointment is made, and moving it is `reschedule`.
  booked: [
    "restart",
    "find_nearby",
    "set_location",
    "search_salons",
    "choose_salon",
    "wallet",
    "check_payment",
    ...MANAGE,
  ],
};

/** One step back along the chain. Later phases extend it. */
export const PREVIOUS_STEP: Partial<Record<Step, Step>> = {
  discover: "greeting",
  salon: "discover",
};

/** What "Back" undoes once the funnel has started: the same clearing `change`
 *  does, aimed one step upstream. */
export const BACK_TARGET: Partial<
  Record<Step, "salon" | "date" | "service" | "counter" | "slot">
> = {
  date: "salon",
  service: "date",
  counter: "service",
  slot: "counter",
  summary: "slot",
};

/**
 * Everything a change invalidates, in step order. Picking a new salon has to
 * drop the service, date, counter and slot chosen at the old one — forgetting
 * this is how a customer ends up booking salon A's slot at salon B.
 */
const DOWNSTREAM = [
  "salonId",
  "serviceId",
  "date",
  "counterId",
  "slotId",
] as const;

type ClearableField =
  | "serviceId"
  | "date"
  | "counterId"
  | "slotId"
  | "staffId"
  | "quoteToken"
  | "holdExtended"
  | "rescheduleOf";

/** A quote and its hold extension belong to one slot, so anything that drops
 *  the slot drops them too. */
const QUOTE: ClearableField[] = ["staffId", "quoteToken", "holdExtended"];

const CLEARED_BY: Record<(typeof DOWNSTREAM)[number], ClearableField[]> = {
  salonId: ["serviceId", "date", "counterId", "slotId", "rescheduleOf", ...QUOTE],
  serviceId: ["counterId", "slotId", ...QUOTE],
  date: ["counterId", "slotId", ...QUOTE],
  counterId: ["slotId", ...QUOTE],
  slotId: QUOTE,
};

/**
 * A top-up that can no longer book anything. Leaving the summary withdraws the
 * "and book" half of the consent — the money still lands, and the chat still
 * asks about it, but it will not take a slot the customer walked away from.
 */
export const withoutAutoConfirm = (pending: PendingTopup): PendingTopup => {
  const { confirmToken: _token, ...rest } = pending;
  return { ...rest, autoConfirm: false };
};

/**
 * "Change the date" is not a write, so `advance` cannot express it — it decides
 * what to clear by comparing a *new* value. This drops the field itself along
 * with everything it invalidated, which is what every `change` tap means.
 */
export const clearFrom = (
  state: AssistantState,
  field: (typeof DOWNSTREAM)[number],
): AssistantState => {
  const next: AssistantState = { ...state };

  delete next[field];
  for (const stale of CLEARED_BY[field]) delete next[stale];

  return next;
};

/** The only way a handler may change the state. */
export const advance = (
  state: AssistantState,
  next: Partial<AssistantState>,
): AssistantState => {
  const merged: AssistantState = { ...state, ...next };

  for (const field of DOWNSTREAM) {
    if (next[field] !== undefined && next[field] !== state[field]) {
      for (const stale of CLEARED_BY[field]) {
        delete merged[stale];
      }
    }
  }

  return merged;
};
