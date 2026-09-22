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

/** What a tap may do from where the customer actually is. Anything else is a
 *  stale tab pressing an old button — answered, not thrown at. */
export const ALLOWED_ACTIONS: Record<Step, ActionType[]> = {
  greeting: [
    "start",
    "find_nearby",
    "set_location",
    "change_location",
    "search_salons",
    "restart",
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
  ],
  salon: [
    "find_nearby",
    "set_location",
    "search_salons",
    "choose_salon",
    "change_location",
    "book", // Phase 2 — stub
    "show_services", // Phase 2 — stub
    "restart",
    "back",
  ],
  date: [], // Phase 2
  service: [], // Phase 2
  counter: [], // Phase 2
  slot: [], // Phase 2
  summary: [], // Phase 2
  payment: [], // Phase 5
  booked: [], // Phase 4
};

/** One step back along the chain. Later phases extend it. */
export const PREVIOUS_STEP: Partial<Record<Step, Step>> = {
  discover: "greeting",
  salon: "discover",
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
