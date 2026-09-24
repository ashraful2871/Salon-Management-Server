import ApiError from "../../Error/error";
import { COPY } from "./assistant.constants";

/**
 * One line per turn, and the vocabulary the funnel report is built from: how
 * many conversations reached the summary, how many confirmed, where the rest
 * stopped. Only anonymous or already-public values go in a line — ids, the
 * step, the action type, the tool names, model and token counts, timings. Never
 * a name, an email, a phone number, coordinates, or anything the customer typed.
 */
export type TurnOutcome =
  | "ok"
  | "blocked"
  | "error"
  | "rate_limited"
  | "slot_taken"
  | "insufficient_funds";

export type TurnLog = {
  cid: string | null;
  turn?: number | null;
  step?: string | null;
  action?: string | null;
  mode?: "guided" | "ai";
  tools?: string[];
  model?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  ms?: number | null;
  outcome: TurnOutcome;
};

export const logTurn = (entry: TurnLog) => {
  console.log(
    `[assistant] ${JSON.stringify({
      cid: entry.cid,
      turn: entry.turn ?? null,
      step: entry.step ?? null,
      action: entry.action ?? null,
      mode: entry.mode ?? "guided",
      tools: entry.tools ?? [],
      model: entry.model ?? null,
      tokensIn: entry.tokensIn ?? 0,
      tokensOut: entry.tokensOut ?? 0,
      ms: entry.ms ?? null,
      outcome: entry.outcome,
    })}`,
  );
};

/**
 * Outcomes that never reach the transcript — a limiter's 429, a thrown error, a
 * turn refused at `MAX_TURNS` — are counted here so `/assistant/stats` can
 * still rank them. Per process, since the last restart; the transcript-backed
 * outcomes come from the database instead.
 */
const unrecorded: Partial<Record<TurnOutcome, number>> = {};
export const countingSince = new Date();

export const unrecordedOutcomes = () => ({ ...unrecorded });

/** A turn that wrote nothing: log it and count it. */
export const logUnrecorded = (entry: TurnLog) => {
  unrecorded[entry.outcome] = (unrecorded[entry.outcome] ?? 0) + 1;
  logTurn(entry);
};

/** A refusal the caller caused (404 not yours, 409 closed, 410 expired…) is
 *  `blocked`; anything else is ours. */
export const failureOutcome = (error: unknown): TurnOutcome =>
  error instanceof ApiError && error.statusCode < 500 ? "blocked" : "error";

const SLOT_LOST = new Set<string>([
  COPY.slotTaken,
  COPY.slotHeld,
  COPY.slotsGone,
  COPY.holdExpired,
  COPY.topupNotHeld,
]);
// Templated ("Your ৳100 is in your wallet. That time was released…"), so it is
// matched on the part after the amount.
const RELEASED_TAIL = COPY.topupReleased.split("{amount}")[1];

/**
 * A recorded turn's outcome, read off the notices it drew. The funnel already
 * says "that time was just taken" in exactly one set of words, so matching the
 * words keeps this in step with the copy without threading a flag through
 * every handler.
 */
export const outcomeOf = (blocks: unknown[]): TurnOutcome => {
  for (const block of blocks as Array<{ type?: string; text?: string }>) {
    if (block?.type !== "notice" || typeof block.text !== "string") continue;
    if (SLOT_LOST.has(block.text) || block.text.endsWith(RELEASED_TAIL)) {
      return "slot_taken";
    }
    if (block.text === COPY.staleTap) return "blocked";
  }
  return "ok";
};
