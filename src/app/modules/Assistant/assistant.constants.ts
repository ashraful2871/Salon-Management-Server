/**
 * The booking assistant is a guided chat: every turn is a tap on a button the
 * server built, handled deterministically. Nothing here calls a model — free
 * text arrives in a later phase and maps onto these same actions.
 */

/** Kill switch. Unset means on; only the literal "false" turns it off. */
export const ASSISTANT_ENABLED = process.env.ASSISTANT_ENABLED !== "false";

/** Per conversation. A guided flow reaches a booking in well under ten turns. */
export const MAX_TURNS = 40;

/** Retention sweep for guests; signed-in chats get longer in a later phase. */
export const CONVERSATION_TTL_DAYS = 30;

/** Salon cards per carousel page. */
export const SALON_CARDS = 5;

/** Matches salonListQuery's own default, so "nearby" means the same thing
 *  in the chat as it does on the salons page. */
export const NEARBY_RADIUS_KM = 5;

/** Retried once when 5 km finds nothing, rather than answering "none". */
export const NEARBY_RADIUS_WIDE_KM = 15;

/** Coordinates are rounded to this many decimals (~110 m), matching the
 *  precision the frontend already stores in its `sm_loc` cookie. */
export const LOCATION_PRECISION = 3;

/** How far ahead the funnel looks, counting today. Three counters x twenty
 *  slots x fourteen days is ~840 narrow rows — one query, no pagination. */
export const MAX_DAYS_AHEAD = Math.min(
  60,
  Math.max(1, Number(process.env.ASSISTANT_MAX_DAYS ?? 14) || 14),
);

/**
 * How long a prepared booking holds its slot. Long enough to read the summary
 * and tap, short enough that a customer who wanders off does not keep a chair
 * off the market. Expiry is checked in the claim predicate, so this is a
 * promise the database keeps without a cleanup job.
 */
export const HOLD_MINUTES = Math.min(
  60,
  Math.max(1, Number(process.env.ASSISTANT_HOLD_MINUTES ?? 10) || 10),
);

/** More than this and a customer is parking chairs rather than choosing one. */
export const MAX_ACTIVE_HOLDS = 2;

/**
 * "Top up & book" extends the hold to this, once. bKash's OTP round trip is the
 * slow part of a gateway visit; ten minutes that started at the summary is not
 * always enough to finish it, twenty nearly always is.
 */
export const TOPUP_HOLD_MINUTES = 20;

/** A second tap on the same amount inside this window re-opens the gateway
 *  page it already started instead of opening a second payment. */
export const TOPUP_REUSE_MINUTES = 10;

/** Poisha. Only those that cover the shortfall are offered. */
export const TOPUP_PRESETS_MINOR = [10000, 20000, 50000];

/** Display only — the gateway page is where the method is actually chosen. */
export const PAYMENT_METHODS = ["bKash", "Nagad", "Card"];

/** Signs the confirmation token. Missing, with the assistant on, is a startup
 *  failure — see assistant.token.ts. */
export const ASSISTANT_TOKEN_SECRET = process.env.ASSISTANT_TOKEN_SECRET ?? "";

/** Where "My bookings" points from a confirmation or a limit notice. */
export const APPOINTMENTS_PATH = "/dashboard/appointments";

/** Where login should land a customer who signed in from the chat itself. */
export const ASSISTANT_PATH = "/assistant";

export const COPY = {
  greeting:
    "Hi! I can find a salon near you and book a time. What would you like to do?",
  locationReason:
    "So I can show the closest salons and real travel distances.",
  noneNearby:
    "Nothing within 5 km, so here is a little wider.",
  nothingFound:
    "I could not find a salon there. Try another area, or start over.",
  salonGone:
    "That salon is not taking bookings right now. Here are the others nearby.",
  notBookable:
    "This salon has not set up its services and chairs for online booking yet. You can still call them, or I can show you another salon nearby.",
  // Never "booked", "confirmed" or "reserved" anywhere in this phase: nothing
  // is held until the review page, and saying otherwise is how a customer
  // arrives to find their chair taken.
  noDates:
    "No free times in the next {days} days. Try another salon nearby?",
  noServices:
    "Nothing bookable is left on that day. Pick another day and I will try again.",
  slotsGone:
    "Those times were taken while you were choosing. Here are the days that still have something free.",
  slotTaken:
    "That time was just taken. Here is what is still free on the same day.",
  badDate: "I cannot book that day. Here are the days that still have space.",
  loginToBook:
    "Sign in when you are ready to book. You can look at the times first.",
  loginToPay: "Sign in to use your wallet.",
  turnLimit:
    "This chat has gone on a while. Start a new one and I will pick things up fresh.",
  staleTap:
    "That option is no longer available here. Here is where we are.",
  // Phase 4. A hold lost to somebody else is the one race the funnel cannot
  // prevent, only recover from.
  slotHeld:
    "Someone is booking that time right now. Here is what else is free on the same day.",
  priceChanged:
    "The price for that time changed while you were deciding, so I have not booked anything. Here are the new figures.",
  quoteExpired:
    "That price quote expired, so I re-checked it. Confirm again if it still suits you.",
  holdExpired:
    "Your hold on that time has run out. Here are the times that are still free.",
  bookedAlready:
    "That booking is already made — here it is again rather than a second one.",
  // Phase 5. Money copy never says "lost", "charged" or "refund": a top-up that
  // did not complete took nothing, and one that did is in the wallet.
  topupOpening:
    "Opening the payment page — come back here when you are done.",
  topupWaiting: "Still waiting for the payment…",
  topupPaid: "{amount} is in your wallet.",
  topupReleased:
    "Your {amount} is in your wallet. That time was released — here are the nearest free ones.",
  topupNotHeld:
    "That time is no longer held for you, so I have not started a payment. Here is what is still free.",
  topupFailed: "The payment did not go through, so nothing was taken.",
  topupCancelled: "The payment was cancelled, so nothing was taken.",
  topupExpired:
    "The payment page timed out before it was finished, so nothing was taken.",
} as const;
