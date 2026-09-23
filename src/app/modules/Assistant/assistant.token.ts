import { createHmac, timingSafeEqual } from "crypto";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import { ASSISTANT_ENABLED, ASSISTANT_TOKEN_SECRET } from "./assistant.constants";

/**
 * The confirmation token proves one thing: *the server quoted these figures to
 * this user for this slot, and not long ago*. It is not a capability — the
 * confirm endpoint re-runs every check from scratch and re-quotes the price —
 * so a leaked token buys nothing that the endpoint would not have allowed
 * anyway.
 *
 * It exists so that Phase 6's model can never invent a booking: the token is
 * built by `handleChooseSlot` into the UI block and travels back through a
 * human tap. It is never put in a model prompt and never returned as a tool
 * result, which is the wall between the model and the money.
 */
export type ConfirmPayload = {
  v: 1;
  /** Conversation. */
  cid: string;
  /** User. */
  uid: string;
  /** Slot. */
  sid: string;
  /** Service, counter, staff. */
  svc: string;
  cnt: string;
  stf?: string;
  /** priceMinor and depositMinor exactly as quoted. */
  pm: number;
  dm: number;
  /** Epoch ms. Matches the slot hold, so a token outlives its hold by nothing. */
  exp: number;
};

// A chat that cannot confirm is worse than no chat: it walks a customer all the
// way to a Confirm button that 500s. Fail on deploy instead — but only when the
// assistant is actually switched on, so a deploy with it off needs no secret.
if (ASSISTANT_ENABLED && !ASSISTANT_TOKEN_SECRET) {
  throw new Error(
    "ASSISTANT_TOKEN_SECRET is not set. The booking assistant cannot sign confirmation tokens without it — set it, or set ASSISTANT_ENABLED=false.",
  );
}

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64url");

const sign = (payload: string): string =>
  createHmac("sha256", ASSISTANT_TOKEN_SECRET)
    .update(payload)
    .digest("base64url");

/** Constant time, and never compares two different lengths. */
const sameSignature = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export const signConfirm = (payload: ConfirmPayload): string => {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
};

/**
 * A token we signed, read back — expired or not. Null for anything else. The
 * top-up path uses this to carry a quote's exact figures across a gateway trip
 * that may outlast it; the booking itself still goes through `verifyConfirm`.
 */
export const peekConfirm = (token: unknown): ConfirmPayload | null => {
  if (typeof token !== "string" || token.length > 2048) return null;

  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  if (!sameSignature(signature, sign(body))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  const payload = parsed as ConfirmPayload;

  // A signature we produced, so these are our own fields; checked anyway
  // because an older deploy's token shape must not reach the booking path.
  const wellFormed =
    payload !== null &&
    typeof payload === "object" &&
    payload.v === 1 &&
    typeof payload.cid === "string" &&
    typeof payload.uid === "string" &&
    typeof payload.sid === "string" &&
    typeof payload.svc === "string" &&
    typeof payload.cnt === "string" &&
    (payload.stf === undefined || typeof payload.stf === "string") &&
    Number.isInteger(payload.pm) &&
    Number.isInteger(payload.dm) &&
    Number.isFinite(payload.exp);

  return wellFormed ? payload : null;
};

/**
 * 400 on anything that is not a token we signed, 410 once the quote has
 * lapsed. The distinction matters to the chat: expiry is recoverable with a
 * fresh quote, a bad signature is not something the customer can fix.
 */
export const verifyConfirm = (token: unknown): ConfirmPayload => {
  const payload = peekConfirm(token);

  if (!payload) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "That confirmation is not valid. Pick your time again and I will re-check the price.",
    );
  }

  if (payload.exp <= Date.now()) {
    throw new ApiError(
      StatusCodes.GONE,
      "That price quote expired. Pick your time again and I will re-check it.",
    );
  }

  return payload;
};

export const AssistantToken = { signConfirm, verifyConfirm, peekConfirm };
