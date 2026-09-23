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
   * The booking this conversation produced, keyed by the `Idempotency-Key`
   * that produced it. A replayed Confirm — a double tap, a retried request —
   * matches the key and is answered with the same appointment instead of a
   * second one. This is the second of the two idempotency guards; the first is
   * the conditional slot claim, which can only ever win once.
   */
  confirm: z
    .object({ key: z.string().max(200), appointmentId: z.string().uuid() })
    .optional(),
});

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
 * Accepted everywhere inside the funnel. A customer is always allowed to walk
 * away to another salon, change something they already picked, or start again —
 * a booking flow that traps you is one you abandon.
 */
const ALWAYS: ActionType[] = [
  "change",
  "restart",
  "back",
  "find_nearby",
  "choose_salon",
  "wallet",
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
  payment: [], // Phase 5
  // A finished booking is not a dead end: the customer may want another salon,
  // their wallet, or to start again. It is deliberately not `change` or
  // `choose_slot` — the appointment is made, and moving it is Phase 7's job.
  booked: ["restart", "find_nearby", "set_location", "choose_salon", "wallet"],
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

type ClearableField = "serviceId" | "date" | "counterId" | "slotId" | "staffId";

const CLEARED_BY: Record<(typeof DOWNSTREAM)[number], ClearableField[]> = {
  salonId: ["serviceId", "date", "counterId", "slotId", "staffId"],
  serviceId: ["counterId", "slotId", "staffId"],
  date: ["counterId", "slotId", "staffId"],
  counterId: ["slotId", "staffId"],
  slotId: ["staffId"],
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
