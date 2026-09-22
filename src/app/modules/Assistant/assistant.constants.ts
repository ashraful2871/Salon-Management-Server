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
  bookingSoon: "Booking in chat is coming next.",
  turnLimit:
    "This chat has gone on a while. Start a new one and I will pick things up fresh.",
  staleTap:
    "That option is no longer available here. Here is where we are.",
} as const;
