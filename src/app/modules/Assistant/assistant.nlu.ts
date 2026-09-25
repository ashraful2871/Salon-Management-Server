import type { SearchIntent } from "../AI-Suggestion/ai.intent";
import type { AssistantAction } from "./assistant.actions";
import { dateLabel } from "./assistant.availability";
import { MAX_DAYS_AHEAD } from "./assistant.constants";
import { normaliseWhen, readWhen } from "./assistant.dates";
import type { AssistantState } from "./assistant.state";
import type { SearchFilters } from "./assistant.validation";

/**
 * Typed text to one of the actions a tap would send, without a model. This is
 * the first thing every message goes through, and the whole of the chat when
 * the model is off, slow or out of quota — so it must never throw.
 *
 * `high` means "this is what they meant, just do it"; `low` means the rules
 * found something but left words unexplained, so the model may do better. A
 * `null` action with a `note` is an answer that needs no action ("I can't
 * book that day"): the current step is drawn again under it.
 */

export type Wish = NonNullable<AssistantState["wish"]>;

export type Interpretation = {
  action: AssistantAction | null;
  confidence: "high" | "low";
  wish?: Wish;
  note?: string;
};

/** The rules half of `understandQuery`. Injected so the eval runs with a fixed
 *  place list and no database. */
export type Understand = (
  text: string,
) => Promise<{ intent: Omit<SearchIntent, "otherPlace" | "englishQuery" | "understoodBy">; leftover: string[] }>;

const FUNNEL = new Set(["date", "service", "counter", "slot", "summary"]);

/** Words that carry no meaning for a search: politeness, "I want", "book". */
const FILLER = new Set(
  (
    "i me my want wanna need would like to get a an the one please pls plz " +
    "instead rather actually just some for book booking appointment an make " +
    "chai chaai lagbe korte korbo kori korao dorkar amar ami jonno ekta ekti te e " +
    "koro kore den dite deo dao hobe kaj cai চাই লাগবে করতে করব আমার আমি একটা জন্য"
  ).split(" "),
);

const has = (text: string, pattern: RegExp) => pattern.test(text);

/** "Did my payment go through?" — answered by the payment module, which owns
 *  the lock and may finish a booking, not by the funnel. */
export const isPaymentQuestion = (input: string): boolean => {
  const text = input.toLowerCase();
  return (
    has(text, /\b(payment|paid|pay|top ?up|recharge)\b/) &&
    has(text, /\b(go through|went through|done|hoise|hoyeche|hoyse|received|landed|status|did|gese|geche)\b/)
  );
};

/** Latin words only; Bangla script needs no case or accents folded. */
const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9ঀ-৿\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

const hour24 = (hour: number, meridiem?: string) => {
  if (meridiem === "am") return hour === 12 ? 0 : hour;
  if (meridiem === "pm") return hour === 12 ? 12 : hour + 12;
  return hour;
};

const pad = (n: number) => String(n).padStart(2, "0");

/** "17:45", "5:45 pm", "5.45", "5pm" → candidate "HH:mm" values, the literal
 *  reading first. Without am/pm both halves of the day are candidates. */
const readTimes = (text: string): string[] | null => {
  let hour: number;
  let minutes = "00";
  let meridiem: string | undefined;
  const clock = /(?<![\d/-])(\d{1,2})[:.](\d{2})\s*(am|pm)?(?!\d)/.exec(text);
  const bare = /(?<![\d/-])(\d{1,2})\s*(am|pm)(?![a-z])/.exec(text);
  if (clock) {
    [hour, minutes, meridiem] = [Number(clock[1]), clock[2], clock[3]];
  } else if (bare) {
    [hour, meridiem] = [Number(bare[1]), bare[2]];
  } else {
    return null;
  }
  if (hour > 23 || Number(minutes) > 59) return null;
  if (meridiem) return [`${pad(hour24(hour, meridiem))}:${minutes}`];
  return hour < 12
    ? [`${pad(hour)}:${minutes}`, `${pad(hour + 12)}:${minutes}`]
    : [`${pad(hour)}:${minutes}`];
};

const ORDINALS: Array<[RegExp, (n: number) => number]> = [
  [/\b(first|1st|prothom|prothomta|earliest|agerta)\b|প্রথম/, () => 0],
  [/\b(second|2nd|ditiyo|dusra|next one)\b|দ্বিতীয়/, () => 1],
  [/\b(third|3rd|tritiyo)\b|তৃতীয়/, () => 2],
  [/\b(last|latest|shesh|sheshta|shesher)\b|শেষ/, (n) => n - 1],
];

const CHEAPEST =
  /\b(cheap(er|est)?|lowest price|less expensive|sosta|shosta|kom dam|kom dame|komdam)\b|সস্তা|কম দাম/;

type Kind = NonNullable<AssistantState["lastOptions"]>["kind"];

/** The picker a step's options belong to. A carousel stays answerable while
 *  its details card is open ("no, the cheaper one"). */
const pickerFor = (state: AssistantState): Kind | null => {
  const kind = state.lastOptions?.kind;
  if (!kind) return null;
  if (kind === "salon") return ["greeting", "discover", "salon"].includes(state.step) ? kind : null;
  if (kind === "slot") return state.step === "slot" || state.step === "summary" ? kind : null;
  return state.step === kind ? kind : null;
};

const chooseAction = (kind: Kind, id: string): AssistantAction => {
  switch (kind) {
    case "salon":
      return { type: "choose_salon", salonId: id };
    case "date":
      return { type: "choose_date", date: id };
    case "service":
      return { type: "choose_service", serviceId: id };
    case "counter":
      return { type: "choose_counter", counterId: id };
    case "slot":
      return { type: "choose_slot", slotId: id };
  }
};

/** An offered name the text points at: "elegance", "classic haircut", "chair b".
 *  Only an unambiguous match counts. */
const byName = <T extends { label: string }>(items: T[], text: string): T | null => {
  const said = words(text).filter((w) => !FILLER.has(w));
  if (!said.length) return null;
  const hits = items.filter((item) => {
    const label = words(item.label);
    const joined = label.join(" ");
    const saidJoined = said.join(" ");
    return (
      joined === saidJoined ||
      (saidJoined.length >= 4 && joined.includes(saidJoined)) ||
      (label.length > 0 && label.every((w) => said.includes(w))) ||
      // A single distinctive word: "elegance", "fade".
      said.some((w) => w.length >= 5 && label.includes(w))
    );
  });
  return hits.length === 1 ? hits[0] : null;
};

const toFilters = (intent: Awaited<ReturnType<Understand>>["intent"]): SearchFilters => ({
  categories: intent.categories,
  serviceTerms: intent.serviceTerms,
  place: intent.place,
  nearMe: intent.nearMe,
  maxPriceMinor: intent.maxPriceMinor,
  minPriceMinor: intent.minPriceMinor,
  budget: intent.budget,
  minRating: intent.minRating,
  sortBy: intent.sortBy,
  openNow: intent.openNow,
});

const isEmpty = (f: SearchFilters) =>
  !f.categories.length &&
  !f.serviceTerms.length &&
  !f.place &&
  !f.nearMe &&
  f.maxPriceMinor === null &&
  f.minPriceMinor === null &&
  !f.budget &&
  f.minRating === null &&
  !f.openNow &&
  f.sortBy === "relevance";

const clean = <T extends Record<string, unknown>>(value: T): T | undefined => {
  const out = Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length)),
  ) as T;
  return Object.keys(out).length ? out : undefined;
};

const interpretUnsafe = async (
  input: string,
  state: AssistantState,
  understand: Understand,
  now: Date,
): Promise<Interpretation | null> => {
  const text = normaliseWhen(input).trim();
  if (!text) return null;

  const when = readWhen(input, now);
  const rest = when.rest;
  const whenWish = clean({
    date: when.date ?? undefined,
    partOfDay: when.partOfDay ?? undefined,
    after: when.after ?? undefined,
  }) as Wish | undefined;
  const picker = pickerFor(state);
  const items = state.lastOptions?.items ?? [];
  const inFunnel = FUNNEL.has(state.step) && Boolean(state.salonId);

  // ---- 1. Step-local shortcuts: answers to the question on screen.

  if (picker === "slot") {
    const times = readTimes(text);
    if (times) {
      const hit = times.map((t) => items.find((i) => i.time === t)).find(Boolean);
      if (hit) return { action: chooseAction("slot", hit.id), confidence: "high" };
      return {
        action: null,
        confidence: "high",
        note: `${times[times.length - 1]} is not free. These are the times that are.`,
      };
    }
    if (when.after && !when.dateMentioned) {
      const hit = items.find((i) => (i.time ?? "") >= when.after!);
      return hit
        ? { action: chooseAction("slot", hit.id), confidence: "high" }
        : { action: null, confidence: "high", note: `Nothing is free after ${when.after} that day.` };
    }
    if (when.partOfDay && !when.dateMentioned) {
      return { action: null, confidence: "high", wish: { partOfDay: when.partOfDay } };
    }
  }

  if (picker && items.length) {
    if (has(text, CHEAPEST) && words(rest).filter((w) => !FILLER.has(w) && !CHEAPEST.test(w)).length <= 1) {
      const priced = items.filter((i) => typeof i.priceMinor === "number");
      if (priced.length) {
        const cheapest = priced.reduce((a, b) => ((b.priceMinor as number) < (a.priceMinor as number) ? b : a));
        return { action: chooseAction(picker, cheapest.id), confidence: "high" };
      }
    }
    if (words(rest).length <= 4) {
      for (const [pattern, pick] of ORDINALS) {
        if (has(rest, pattern)) {
          const item = items[pick(items.length)];
          if (item) return { action: chooseAction(picker, item.id), confidence: "high" };
        }
      }
    }
    if (picker !== "slot" && picker !== "date") {
      const named = byName(items, rest);
      if (named) return { action: chooseAction(picker, named.id), confidence: "high", wish: whenWish };
    }
  }

  // A day, typed anywhere. Past or beyond the window is asked again, never
  // guessed at.
  if (when.dateMentioned && !when.date) {
    return {
      action: null,
      confidence: "high",
      note: `I can book from today up to ${MAX_DAYS_AHEAD} days ahead. Which day would you like?`,
    };
  }

  // ---- 2. Intent words, anywhere.

  // A command, not a question: "can I cancel for free?" is about the policy,
  // and dropping their draft in answer would be exactly wrong.
  const isQuestion = has(text, /\?|\b(can|could|how|what|when|is|do|does|will|if|jodi|ki|kivabe)\b|কি |কীভাবে/);
  if (!isQuestion && has(text, /\b(cancel|batil|baad dao|bad dao)\b|বাতিল/)) {
    // Phase 7 gives "cancel" a bookings list; until then it drops the draft.
    return { action: { type: "restart" }, confidence: "high" };
  }
  if (has(text, /\b(start over|restart|start again|notun kore|shuru theke)\b|নতুন করে/)) {
    return { action: { type: "restart" }, confidence: "high" };
  }
  if (has(text, /\b(another|other|different|onno|arekta|anno)\s+(salon|parlou?r|place|jaygay?)\b|অন্য (সেলুন|পার্লার)/)) {
    return { action: { type: "find_nearby" }, confidence: "high" };
  }
  if (isPaymentQuestion(text)) {
    return { action: { type: "check_payment" }, confidence: "high" };
  }
  if (
    has(text, /\b(wallet|balance)\b|ওয়ালেট|ব্যালেন্স/) ||
    (has(text, /\b(taka|tk)\b|টাকা/) && !/\d/.test(text) && has(text, /\b(koto|ache|ase|kot|how much|my)\b|কত|আছে/))
  ) {
    return { action: { type: "wallet" }, confidence: "high" };
  }
  if (has(text, /^(go )?back$|^(pichone|pichhe|fire jao|ager ta)$|^ফিরে/)) {
    return { action: { type: "back" }, confidence: "high" };
  }
  if (has(text, /\b(confirm|nishchit|pakka)\b|নিশ্চিত/) && state.step === "summary") {
    return {
      action: null,
      confidence: "high",
      note: "Tap Confirm on the summary to book — I can only get it ready, not book it for you.",
    };
  }
  if (inFunnel && has(text, /\b(another|different|other|onno) (day|date|din)\b|change (the )?(day|date)|অন্য দিন/)) {
    return { action: { type: "change", target: "date" }, confidence: "high" };
  }
  if (inFunnel && has(text, /\b(another|different|other|onno) (time|shomoy|somoy)\b|change (the )?time/)) {
    return { action: { type: "change", target: "slot" }, confidence: "high" };
  }

  // ---- 3. A request: rules for services, places, prices.

  const understood = await understand(rest);
  const filters = toFilters(understood.intent);
  const leftover = understood.leftover.flatMap(words).filter((w) => !FILLER.has(w) && !/^\d+$/.test(w));
  const confidence = leftover.length ? "low" : "high";
  const serviceWish = clean({
    categories: filters.categories.length ? filters.categories : undefined,
    serviceTerms: filters.serviceTerms.length ? filters.serviceTerms : undefined,
  });
  const wish = clean({ ...whenWish, ...serviceWish }) as Wish | undefined;

  // Inside a salon, a date or a service is an answer about *this* salon, not a
  // new search — unless they named somewhere else.
  const aboutThisSalon = state.salonId && !filters.place && !filters.nearMe && state.step !== "discover";

  if (aboutThisSalon && (when.date || serviceWish)) {
    if (when.date && inFunnel) {
      return { action: { type: "choose_date", date: when.date }, confidence, wish: clean({ ...whenWish, ...serviceWish, date: undefined }) };
    }
    if (inFunnel || state.step === "salon") {
      return {
        action: when.date || state.step === "salon" ? { type: "book" } : { type: "show_services" },
        confidence,
        wish,
      };
    }
  }

  if (!isEmpty(filters)) {
    return {
      action: { type: "search_salons", query: input.trim().slice(0, 300), filters },
      confidence,
      wish,
    };
  }

  if (when.date || when.partOfDay) {
    // A day with nothing else: keep it for when a salon is chosen.
    if (state.step === "discover" && state.lastOptions?.kind === "salon") {
      return {
        action: null,
        confidence: "high",
        wish,
        note: when.date
          ? `Pick a salon and I will show the times for ${dateLabel(when.date)}.`
          : "Pick a salon and I will show those times first.",
      };
    }
    return { action: { type: "find_nearby" }, confidence: "high", wish };
  }

  if (has(text, /^(book|booking|appointment|yes|ok|okay|haa?|hya|ji|sure)\b/)) {
    return {
      action: state.step === "salon" ? { type: "book" } : { type: "find_nearby" },
      confidence: leftover.length > 2 ? "low" : "high",
    };
  }

  return null;
};

/**
 * Never throws: it is also what runs when the model cannot, so a bug in here
 * must cost an understood message, not the turn.
 */
export const interpret = async (
  text: string,
  state: AssistantState,
  understand: Understand,
  now = new Date(),
): Promise<Interpretation | null> => {
  try {
    return await interpretUnsafe(text, state, understand, now);
  } catch (error) {
    console.warn(`[assistant.nlu] could not read a message: ${(error as Error).message}`);
    return null;
  }
};
