import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { formatBDT } from "../../utils/money";
import { hasSlotStarted, slotStartsAt } from "../../utils/slotTime";
import { isOpenNow } from "../AI-Suggestion/ai.search";
import { resolveDepositMinor } from "../Appointment/appointment.deposit";
import {
  AppointmentService,
  type BookingQuote,
} from "../Appointment/appointment.service";
import { PaymentIntentService } from "../Payment/paymentIntent.service";
import { SalonService } from "../Salon/salon.service";
import { BD_BOUNDS, SalonValidation } from "../Salon/salon.validation";
import { WalletService } from "../Wallet/wallet.service";
import {
  OpenSlot,
  counterOptions,
  dateLabel,
  dhakaToday,
  groupDates,
  isYmd,
  loadOpenSlots,
  serviceOptions,
  shiftYmd,
  slotGroups,
  toCalendarDate,
  toYmd,
} from "./assistant.availability";
import {
  Block,
  CounterOption,
  QuickReply,
  SalonCard,
  SalonPolicy,
  ServiceOption,
  bookingConfirmed,
  bookingSummary,
  counterPicker,
  datePicker,
  locationRequest,
  loginRequired,
  notice,
  quickReplies,
  salonCarousel,
  salonDetails,
  paymentPromptBlock,
  servicePicker,
  slotPicker,
  walletStatus,
} from "./assistant.blocks";
import { heldUntilFor, holdSlot, releaseSlot } from "./assistant.booking";
import {
  APPOINTMENTS_PATH,
  ASSISTANT_PATH,
  ASSISTANT_TOPUP_ENABLED,
  COPY,
  HOLD_MINUTES,
  LOCATION_PRECISION,
  MAX_DAYS_AHEAD,
  NEARBY_RADIUS_KM,
  NEARBY_RADIUS_WIDE_KM,
  PAYMENT_METHODS,
  SALON_CARDS,
  TOPUP_PRESETS_MINOR,
} from "./assistant.constants";
import {
  ALLOWED_ACTIONS,
  AssistantState,
  BACK_TARGET,
  PREVIOUS_STEP,
  advance,
  clearFrom,
  withoutAutoConfirm,
} from "./assistant.state";
import {
  peekConfirm,
  signConfirm,
  type ConfirmPayload,
} from "./assistant.token";
import { bandFor } from "./assistant.dates";
import {
  AssistantManage,
  rescheduleInfo,
  withReturningExtras,
} from "./assistant.manage";
import { AssistantValidation, type SearchFilters } from "./assistant.validation";
import { rankSalons } from "../AI-Suggestion/ai.search";
import { CATEGORY_LABELS } from "../AI-Suggestion/ai.constants";

/**
 * Every turn in this phase is deterministic: an action comes in, the server
 * changes state, builds blocks and answers. No model call anywhere. Free text
 * arrives later by mapping onto these same actions.
 */
export type AssistantAction =
  | { type: "start" }
  | { type: "find_nearby"; page?: number }
  | { type: "set_location"; lat: number; lng: number; label?: string }
  // With `filters`: a typed message, read into AI search's filters and ranked
  // the same way. Without: the plain name/area search.
  | { type: "search_salons"; query: string; page?: number; filters?: SearchFilters }
  | { type: "choose_salon"; salonId: string }
  // The "Change location" chip: re-asks, rather than re-running the search from
  // the location we already hold.
  | { type: "change_location" }
  // The funnel. `book` and `show_services` are two doors into the same rooms:
  // date and service may be answered in either order.
  | { type: "book" }
  | { type: "show_services" }
  | { type: "choose_date"; date: string }
  | { type: "choose_service"; serviceId: string }
  | { type: "choose_counter"; counterId: string }
  | { type: "choose_slot"; slotId: string }
  | { type: "change"; target: ChangeTarget }
  | { type: "wallet" }
  // "Has my top-up landed?" Answered by `AssistantPayment.checkPayment`, which
  // the controller routes it to; `runAction` only ever draws the no-top-up
  // answer for it.
  | { type: "check_payment" }
  | { type: "restart" }
  | { type: "back" }
  // Managing bookings that already exist (assistant.manage.ts). Cancelling is
  // two taps on purpose: `cancel_booking` only shows what it would cost.
  | { type: "my_bookings"; scope?: "upcoming" | "past" }
  | { type: "cancel_booking"; appointmentId: string }
  | { type: "cancel_confirm"; appointmentId: string }
  | { type: "reschedule"; appointmentId: string }
  | { type: "book_usual"; appointmentId: string }
  | { type: "rate_booking"; appointmentId: string; rating: number };

export type ChangeTarget = "salon" | "date" | "service" | "counter" | "slot";

export type TurnResult = {
  text: string;
  blocks: Block[];
  state: AssistantState;
};

/**
 * Who is asking. The wallet and the slot hold are the only things that differ
 * between a signed-in customer and a guest; the conversation id goes into the
 * confirmation token, which is what binds a quote to this chat.
 */
export type TurnContext = {
  userId?: string;
  conversationId?: string;
  /** The first turn of a new conversation, run inside its create request. */
  opening?: boolean;
};

/* ------------------------------------------------------------------ cards */

/** What getAllSalons hands back, narrowed to the fields a card needs. */
type SalonRow = {
  id: string;
  name: string;
  area: string;
  city: string;
  images: string[];
  rating: number;
  totalReviews: number;
  operatingHours: unknown;
  services?: { priceMinor: number; isActive: boolean }[];
  counters?: { isActive: boolean }[];
  distanceMeters?: number;
};

/** "850 m away" under a kilometre, "1.2 km away" over it. */
const formatDistance = (metres: number): string =>
  metres < 1000
    ? `${Math.round(metres / 10) * 10} m away`
    : `${(metres / 1000).toFixed(1)} km away`;

const cheapestActive = (
  services: { priceMinor: number; isActive: boolean }[] | undefined,
): number | null => {
  const prices = (services ?? [])
    .filter((s) => s.isActive)
    .map((s) => s.priceMinor);
  return prices.length ? Math.min(...prices) : null;
};

const toCard = (row: SalonRow): SalonCard => {
  const distanceMeters = row.distanceMeters ?? null;
  const priceFromMinor = cheapestActive(row.services);
  const openNow = isOpenNow(row.operatingHours);
  const serviceCount = (row.services ?? []).filter((s) => s.isActive).length;
  const counterCount = (row.counters ?? []).filter((c) => c.isActive).length;

  const reasons: string[] = [];
  if (distanceMeters !== null) reasons.push(formatDistance(distanceMeters));
  if (openNow === true) reasons.push("Open now");
  if (priceFromMinor !== null) reasons.push(`From ${formatBDT(priceFromMinor)}`);

  // Shown, but honestly labelled. Hiding these makes an area look empty when it
  // is not; the customer can still call the salon or get directions.
  if (serviceCount === 0 || counterCount === 0) {
    reasons.push("Not bookable online yet");
  }

  return {
    id: row.id,
    name: row.name,
    area: row.area,
    city: row.city,
    image: row.images[0] ?? null,
    rating: row.rating,
    totalReviews: row.totalReviews,
    distanceMeters,
    priceFromMinor,
    openNow,
    serviceCount,
    counterCount,
    reasons,
  };
};

const isBookable = (card: SalonCard) =>
  card.serviceCount > 0 && card.counterCount > 0;

/** Bookable salons first, otherwise the order the search returned. */
const toCards = (rows: SalonRow[]): SalonCard[] =>
  rows
    .map(toCard)
    .sort((a, b) => Number(isBookable(b)) - Number(isBookable(a)));

const chooseSalonReply = (card: SalonCard): QuickReply => ({
  label: card.name,
  action: { type: "choose_salon", salonId: card.id },
  icon: "scissors",
});

/* ---------------------------------------------------------------- handlers */

const startBlocks = (): Block[] => [
  quickReplies([
    {
      label: "📍 Find salons near me",
      action: { type: "find_nearby" },
      style: "primary",
      icon: "map-pin",
    },
    // The salon is chosen first either way, so booking starts in the same place.
    {
      label: "✂️ Book an appointment",
      action: { type: "find_nearby" },
      icon: "scissors",
    },
    { label: "💳 My wallet", action: { type: "wallet" }, icon: "wallet" },
    { label: "📅 My bookings", action: { type: "my_bookings" }, icon: "calendar" },
  ]),
];

const handleStart = (state: AssistantState): TurnResult => ({
  text: COPY.greeting,
  blocks: startBlocks(),
  state: advance(state, { step: "greeting" }),
});

/** Ask again, keeping the old location until a new one actually arrives. */
const handleChangeLocation = (state: AssistantState): TurnResult => ({
  text: "Where should I look?",
  blocks: [locationRequest(COPY.locationReason, true)],
  state,
});

/**
 * The list of salons near the saved location. Without one we ask for it rather
 * than guessing — a wrong centre is worse than a question.
 */
const handleFindNearby = async (
  state: AssistantState,
  action: Extract<AssistantAction, { type: "find_nearby" }>,
): Promise<TurnResult> => {
  if (!state.location) {
    return {
      text: "Where should I look?",
      blocks: [
        locationRequest(COPY.locationReason, true),
        quickReplies([
          {
            label: "Search by area instead",
            action: { type: "search_salons", query: "" },
            style: "ghost",
          },
        ]),
      ],
      state: advance(state, { step: "greeting" }),
    };
  }

  const { lat, lng } = state.location;
  const page = action.page ?? 1;

  // Built through parse, not as a literal: page, limit and radiusKm are
  // required on SalonListQuery and only get their defaults by parsing.
  const search = (radiusKm: number) =>
    SalonService.getAllSalons(
      SalonValidation.salonListQuery.parse({
        lat,
        lng,
        radiusKm,
        sort: "distance",
        page,
        limit: SALON_CARDS,
      }),
      // The chat is a customer surface: no user means the public projection.
      undefined,
    );

  let result = await search(NEARBY_RADIUS_KM);
  let widened = false;

  if (result.data.length === 0 && page === 1) {
    result = await search(NEARBY_RADIUS_WIDE_KM);
    widened = true;
  }

  const cards = toCards(result.data as SalonRow[]);
  const next = advance(state, { step: "discover" });

  if (cards.length === 0) {
    return {
      text: COPY.nothingFound,
      blocks: [
        notice("info", COPY.nothingFound),
        quickReplies([
          {
            label: "Change location",
            action: { type: "change_location" },
            icon: "map-pin",
          },
          { label: "Start over", action: { type: "restart" }, style: "ghost" },
        ]),
      ],
      state: next,
    };
  }

  const hasMore = result.meta.total > page * SALON_CARDS;
  const text = widened
    ? COPY.noneNearby
    : `${cards.length} salon${cards.length === 1 ? "" : "s"} near ${state.location.label}, closest first.`;

  return {
    text,
    blocks: [
      salonCarousel(
        cards,
        hasMore ? { type: "find_nearby", page: page + 1 } : undefined,
      ),
      quickReplies([
        ...cards.slice(0, 3).map(chooseSalonReply),
        ...(hasMore
          ? [
              {
                label: "Show more",
                action: { type: "find_nearby", page: page + 1 } as const,
              },
            ]
          : []),
        {
          label: "Change location",
          action: { type: "change_location" } as const,
          icon: "map-pin",
        },
        {
          label: "Start over",
          action: { type: "restart" } as const,
          style: "ghost" as const,
        },
      ]),
    ],
    state: next,
  };
};

/** Rounded to ~110 m, the same precision the frontend keeps in `sm_loc`. */
const round = (value: number): number =>
  Number(value.toFixed(LOCATION_PRECISION));

const handleSetLocation = async (
  state: AssistantState,
  action: Extract<AssistantAction, { type: "set_location" }>,
): Promise<TurnResult> => {
  const inside =
    action.lat >= BD_BOUNDS.minLat &&
    action.lat <= BD_BOUNDS.maxLat &&
    action.lng >= BD_BOUNDS.minLng &&
    action.lng <= BD_BOUNDS.maxLng;

  if (!inside) {
    return {
      text: "That spot is outside Bangladesh, so I cannot search from it.",
      blocks: [
        notice("warn", "That spot is outside Bangladesh."),
        locationRequest(COPY.locationReason, true),
      ],
      state,
    };
  }

  const located = advance(state, {
    location: {
      lat: round(action.lat),
      lng: round(action.lng),
      label: (action.label ?? "your location").slice(0, 80),
    },
  });

  return handleFindNearby(located, { type: "find_nearby" });
};

/** "haircut in Dhanmondi under ৳500" — what the filters asked for, in words
 *  built from the filters themselves, never from the model. */
export const describeFilters = (filters: SearchFilters): string => {
  const parts: string[] = [];
  const services = filters.categories.map((c) => CATEGORY_LABELS[c].toLowerCase());
  parts.push(services.length ? services.join(" or ") : filters.serviceTerms.join(" or "));
  if (filters.place) parts.push(`in ${filters.place.label}`);
  else if (filters.nearMe) parts.push("near you");
  if (filters.maxPriceMinor !== null) parts.push(`under ${formatBDT(filters.maxPriceMinor)}`);
  if (filters.minRating !== null) parts.push(`rated ${filters.minRating}+`);
  if (filters.openNow) parts.push("open now");
  return parts.filter(Boolean).join(" ");
};

/** Ranked like AI search — same filters, same scoring — minus the embedding
 *  and the written reply: both are model calls, and a tap must not make one. */
const RANKED_MAX = 12;

const handleRankedSearch = async (
  state: AssistantState,
  action: Extract<AssistantAction, { type: "search_salons" }> & { filters: SearchFilters },
): Promise<TurnResult> => {
  const { filters } = action;
  const page = action.page ?? 1;

  if (filters.nearMe && !filters.place && !state.location) {
    return {
      text: "Where should I look? Share your location and I will search near you.",
      blocks: [locationRequest(COPY.locationReason, true)],
      // Picked up again by `followWish` when the location arrives.
      state: advance(state, {
        step: "greeting",
        wish: { ...state.wish, search: { ...action, page: 1 } },
      }),
    };
  }

  const limit = Math.min(RANKED_MAX, page * SALON_CARDS);
  const ranked = await rankSalons({
    intent: { ...filters, otherPlace: null, englishQuery: null, understoodBy: "rules" },
    vector: null,
    origin: state.location ? { ...state.location, source: "user" } : null,
    limit,
    query: action.query,
  });
  const rows = ranked.salons.slice((page - 1) * SALON_CARDS, limit);

  const counters = rows.length
    ? await prisma.counter.groupBy({
        by: ["salonId"],
        where: { salonId: { in: rows.map((r) => r.id) }, isActive: true, isDeleted: false },
        _count: { _all: true },
      })
    : [];
  const counterCount = new Map(counters.map((c) => [c.salonId, c._count._all]));

  const cards = rows.map((row): SalonCard => {
    const card = toCard({
      ...row,
      distanceMeters: row.distanceMeters ?? undefined,
      services: row.services.map((s) => ({ priceMinor: s.priceMinor, isActive: true })),
      counters: Array.from({ length: counterCount.get(row.id) ?? 0 }, () => ({ isActive: true })),
    });
    // The asked-for service's price, not the salon's cheapest trim.
    const matched = row.matchedServices.map((s) => s.priceMinor);
    return {
      ...card,
      priceFromMinor: matched.length ? Math.min(...matched) : card.priceFromMinor,
      reasons: [...new Set([...row.reasons.map((r) => r.text), ...card.reasons])].slice(0, 4),
    };
  });

  const next = advance(state, { step: "discover", lastQuery: action.query.slice(0, 300) });
  const described = describeFilters(filters);
  // "salons for haircut in Dhanmondi", but "salons in Dhaka" — no dangling "for".
  const what = !described
    ? `for "${action.query}"`
    : filters.categories.length || filters.serviceTerms.length
      ? `for ${described}`
      : described;

  if (cards.length === 0) {
    return {
      text: `I could not find a salon ${what}.`,
      blocks: [
        notice("info", `No salons found ${what}.`),
        quickReplies([
          { label: "Find salons near me", action: { type: "find_nearby" }, icon: "map-pin" },
          { label: "Start over", action: { type: "restart" }, style: "ghost" },
        ]),
      ],
      state: next,
    };
  }

  const hasMore = ranked.salons.length === limit && limit < RANKED_MAX;
  const more = { ...action, page: page + 1 };

  return {
    text: `I found ${cards.length} salon${cards.length === 1 ? "" : "s"} ${what}. Tap one to see its times.`,
    blocks: [
      ...ranked.notes.slice(0, 1).map((note) => notice("info", note)),
      salonCarousel(cards, hasMore ? more : undefined),
      quickReplies([
        ...cards.slice(0, 3).map(chooseSalonReply),
        ...(hasMore ? [{ label: "Show more", action: more }] : []),
        { label: "Start over", action: { type: "restart" } as const, style: "ghost" as const },
      ]),
    ],
    state: next,
  };
};

/** The no-location fallback, and the seed of free-text search in Phase 6. */
const handleSearchSalons = async (
  state: AssistantState,
  action: Extract<AssistantAction, { type: "search_salons" }>,
): Promise<TurnResult> => {
  if (action.filters) return handleRankedSearch(state, { ...action, filters: action.filters });

  const query = action.query.trim();

  if (!query) {
    return {
      text: "Which area should I search? Tell me a place, or share your location.",
      blocks: [locationRequest(COPY.locationReason, true)],
      state: advance(state, { step: "greeting" }),
    };
  }

  const page = action.page ?? 1;
  const result = await SalonService.getAllSalons(
    SalonValidation.salonListQuery.parse({
      searchTerm: query,
      page,
      limit: SALON_CARDS,
      status: "ACTIVE",
      ...(state.location
        ? {
            lat: state.location.lat,
            lng: state.location.lng,
            radiusKm: 50,
            sort: "distance",
          }
        : {}),
    }),
    undefined,
  );

  const cards = toCards(result.data as SalonRow[]);
  const next = advance(state, { step: "discover", lastQuery: query.slice(0, 300) });

  if (cards.length === 0) {
    return {
      text: COPY.nothingFound,
      blocks: [
        notice("info", `No salons matched "${query}".`),
        quickReplies([
          {
            label: "Find salons near me",
            action: { type: "find_nearby" },
            icon: "map-pin",
          },
          { label: "Start over", action: { type: "restart" }, style: "ghost" },
        ]),
      ],
      state: next,
    };
  }

  const hasMore = result.meta.total > page * SALON_CARDS;

  return {
    text: `Here is what I found for "${query}".`,
    blocks: [
      salonCarousel(
        cards,
        hasMore
          ? { type: "search_salons", query, page: page + 1 }
          : undefined,
      ),
      quickReplies([
        ...cards.slice(0, 3).map(chooseSalonReply),
        {
          label: "Find salons near me",
          action: { type: "find_nearby" } as const,
          icon: "map-pin",
        },
        {
          label: "Start over",
          action: { type: "restart" } as const,
          style: "ghost" as const,
        },
      ]),
    ],
    state: next,
  };
};

/**
 * The salon plus everything the funnel filters against. Active and not deleted
 * on both sides: a retired chair's slots are not for sale, and neither is a
 * service the owner has switched off.
 */
export const loadSalon = (salonId: string) =>
  prisma.salon.findFirst({
    where: { id: salonId, status: "ACTIVE", isDeleted: false },
    include: {
      services: {
        where: { isActive: true, isDeleted: false },
        orderBy: { priceMinor: "asc" },
      },
      counters: {
        where: { isActive: true, isDeleted: false },
        orderBy: { name: "asc" },
      },
    },
  });

type LoadedSalon = NonNullable<Awaited<ReturnType<typeof loadSalon>>>;

export const salonGone = (state: AssistantState): TurnResult => ({
  text: COPY.salonGone,
  blocks: [
    notice("warn", COPY.salonGone),
    quickReplies([
      {
        label: "Salons near me",
        action: { type: "find_nearby" },
        icon: "map-pin",
      },
      { label: "Start over", action: { type: "restart" }, style: "ghost" },
    ]),
  ],
  state: advance(state, { step: "discover" }),
});

const handleChooseSalon = async (
  state: AssistantState,
  action: Extract<AssistantAction, { type: "choose_salon" }>,
): Promise<TurnResult> => {
  const salon = await loadSalon(action.salonId);

  if (!salon) return salonGone(state);

  const card = toCard(salon as unknown as SalonRow);
  const policy: SalonPolicy = {
    depositMinor: salon.depositMinor,
    depositPercent: salon.depositPercent,
    cancellationWindowMin: salon.cancellationWindowMin,
    phone: salon.phone,
    address: salon.address,
  };

  const bookable = salon.services.length > 0 && salon.counters.length > 0;

  const actions: QuickReply[] = [
    ...(bookable
      ? ([
          {
            label: "Book appointment",
            action: { type: "book" },
            style: "primary",
            icon: "calendar",
          },
          {
            label: "See services",
            action: { type: "show_services" },
            icon: "scissors",
          },
        ] as QuickReply[])
      : []),
    // Call and Directions are handled client-side from policy.phone and the
    // salon's coordinates — no action round trip.
    { label: "Another salon", action: { type: "find_nearby" }, icon: "map-pin" },
  ];

  return {
    text: bookable
      ? `${salon.name}, ${salon.area}. Tap Book appointment and I will find you a time.`
      : `${salon.name}, ${salon.area}. ${COPY.notBookable}`,
    blocks: [
      salonDetails(card, policy, actions),
      ...(bookable ? [] : [notice("info", COPY.notBookable)]),
    ],
    state: advance(state, { step: "salon", salonId: salon.id }),
  };
};

/* ----------------------------------------------------------------- funnel */

/** One or two short sentences: what was just chosen, then the one question. */
const say = (lead: string, question: string): string =>
  lead ? `${lead} ${question}` : question;

/** Today plus the next MAX_DAYS_AHEAD - 1 days, as both strings and the UTC
 *  midnights `slot.date` is stored at. */
const bookingWindow = (now = new Date()) => {
  const today = dhakaToday(now);
  const lastDay = shiftYmd(today, MAX_DAYS_AHEAD - 1);

  return {
    today,
    lastDay,
    from: toCalendarDate(today),
    to: toCalendarDate(lastDay),
  };
};

/**
 * Prepend the reason to a freshly rendered step. When the re-render had to bail
 * somewhere else — no dates left at all, say — its own message is the more
 * useful one, so it wins rather than being buried under ours.
 */
const because = (
  result: TurnResult,
  text: string,
  expected: Block["type"],
): TurnResult =>
  result.blocks.some((block) => block.type === expected)
    ? { ...result, text, blocks: [notice("warn", text), ...result.blocks] }
    : result;

/** The way out of every funnel step. A customer who cannot leave is a customer
 *  who closes the tab. */
const funnelChips = (
  state: AssistantState,
  extra: QuickReply[] = [],
): QuickReply[] => [
  ...extra,
  ...(state.date
    ? [
        {
          label: "Change day",
          action: { type: "change", target: "date" },
          style: "ghost",
        } as QuickReply,
      ]
    : []),
  ...(state.serviceId
    ? [
        {
          label: "Change service",
          action: { type: "change", target: "service" },
          style: "ghost",
        } as QuickReply,
      ]
    : []),
  { label: "Another salon", action: { type: "find_nearby" }, icon: "map-pin" },
  { label: "Start over", action: { type: "restart" }, style: "ghost" },
];

const notBookable = (
  state: AssistantState,
  salon: LoadedSalon,
): TurnResult => ({
  text: COPY.notBookable,
  blocks: [
    notice("info", COPY.notBookable),
    quickReplies([
      {
        label: "Another salon",
        action: { type: "find_nearby" },
        style: "primary",
        icon: "map-pin",
      },
      { label: "Start over", action: { type: "restart" }, style: "ghost" },
    ]),
  ],
  state: advance(state, { step: "salon", salonId: salon.id }),
});

/** An empty window is a dead end unless it comes with somewhere else to go. */
const noDates = (state: AssistantState): TurnResult => {
  const text = COPY.noDates.replace("{days}", String(MAX_DAYS_AHEAD));

  return {
    text,
    blocks: [
      notice("info", text),
      quickReplies([
        {
          label: "Salons near me",
          action: { type: "find_nearby" },
          style: "primary",
          icon: "map-pin",
        },
        { label: "Start over", action: { type: "restart" }, style: "ghost" },
      ]),
    ],
    state: advance(state, { step: "salon" }),
  };
};

/* --------------------------------------------------------------- the steps */

export const renderDates = async (
  state: AssistantState,
  salon: LoadedSalon,
  lead: string,
  extra: QuickReply[] = [],
): Promise<TurnResult> => {
  const window = bookingWindow();
  const slots = await loadOpenSlots({
    salonId: salon.id,
    from: window.from,
    to: window.to,
    ...(state.serviceId ? { serviceId: state.serviceId } : {}),
  });

  const dates = groupDates(slots, window.today);

  if (dates.length === 0) return noDates(state);

  return {
    text: say(lead, "Which day suits you?"),
    blocks: [
      datePicker({
        salonId: salon.id,
        serviceId: state.serviceId ?? null,
        dates,
      }),
      quickReplies(funnelChips(state, extra)),
    ],
    state: advance(state, { step: "date" }),
  };
};

const renderServices = async (
  state: AssistantState,
  salon: LoadedSalon,
  lead: string,
): Promise<TurnResult> => {
  const window = bookingWindow();
  // Before a day is chosen this browses the whole window; after one, only what
  // that day can actually take.
  const day = state.date ? toCalendarDate(state.date) : null;

  const slots = await loadOpenSlots({
    salonId: salon.id,
    from: day ?? window.from,
    to: day ?? window.to,
  });

  const options = serviceOptions(slots, salon.services);

  if (options.length === 0) {
    return state.date
      ? because(
          await renderDates(clearFrom(state, "date"), salon, ""),
          COPY.noServices,
          "date_picker",
        )
      : noDates(state);
  }

  const services: ServiceOption[] = options.map(({ service, slotCount }) => ({
    id: service.id,
    name: service.name,
    category: service.category,
    priceMinor: service.priceMinor,
    duration: service.duration,
    depositMinor: resolveDepositMinor(salon, service.priceMinor),
    slotCount,
  }));

  return {
    text: say(
      lead,
      // Naming the day explains why the list is short — otherwise a salon with
      // eight services looks like it only has one.
      state.date
        ? `Which service would you like on ${dateLabel(state.date)}?`
        : "Which service would you like?",
    ),
    blocks: [
      servicePicker({
        salonId: salon.id,
        date: state.date ?? null,
        services,
      }),
      quickReplies(funnelChips(state)),
    ],
    state: advance(state, { step: "service" }),
  };
};

const renderCounters = async (
  state: AssistantState,
  salon: LoadedSalon,
  lead: string,
): Promise<TurnResult> => {
  if (!state.date || !state.serviceId) return advanceFunnel(state, salon, lead);

  const day = toCalendarDate(state.date);
  const slots = await loadOpenSlots({
    salonId: salon.id,
    from: day,
    to: day,
    serviceId: state.serviceId,
  });

  const options = counterOptions(slots, salon.counters);

  if (options.length === 0) {
    return because(
      await renderDates(clearFrom(state, "date"), salon, ""),
      COPY.slotsGone,
      "date_picker",
    );
  }

  // One chair means there is nothing to choose. Asking anyway is a tap that
  // teaches the customer nothing, so we pick it and say which one.
  if (options.length === 1) {
    const only = options[0];

    return renderSlots(advance(state, { counterId: only.counter.id }), salon, lead, {
      counter: only.counter,
      slots: only.slots,
      question: `${only.counter.name} is free at these times. Which one?`,
    });
  }

  const counters: CounterOption[] = options
    .map(({ counter, slots: own }) => ({
      id: counter.id,
      name: counter.name,
      code: counter.code,
      slotCount: own.length,
    }))
    .sort((a, b) => b.slotCount - a.slotCount || a.name.localeCompare(b.name));

  return {
    text: say(lead, "Which chair would you like?"),
    blocks: [counterPicker(counters), quickReplies(funnelChips(state))],
    state: advance(state, { step: "counter" }),
  };
};

const renderSlots = async (
  state: AssistantState,
  salon: LoadedSalon,
  lead: string,
  options?: {
    counter?: LoadedSalon["counters"][number];
    slots?: OpenSlot[];
    question?: string;
  },
): Promise<TurnResult> => {
  if (!state.date || !state.serviceId || !state.counterId) {
    return advanceFunnel(state, salon, lead);
  }

  const chair =
    options?.counter ?? salon.counters.find((c) => c.id === state.counterId);

  // The chair was switched off between two taps: fall back to whoever is left.
  if (!chair) return renderCounters(clearFrom(state, "counterId"), salon, lead);

  let own = options?.slots;

  if (!own) {
    const day = toCalendarDate(state.date);
    const slots = await loadOpenSlots({
      salonId: salon.id,
      from: day,
      to: day,
      serviceId: state.serviceId,
      counterId: state.counterId,
    });
    // Through counterOptions, not straight from the query, so a shared slot and
    // this chair's own slot at the same minute collapse to one button — exactly
    // as the website's modal does it.
    own = counterOptions(slots, [chair])[0]?.slots ?? [];
  }

  const groups = slotGroups(own);

  if (groups.length === 0) {
    return because(
      await renderDates(clearFrom(state, "date"), salon, ""),
      COPY.slotsGone,
      "date_picker",
    );
  }

  return {
    text: say(lead, options?.question ?? "What time works for you?"),
    blocks: [
      slotPicker({
        date: state.date,
        counterName: chair.name,
        groups,
      }),
      quickReplies(
        funnelChips(state, [
          {
            label: "Change chair",
            action: { type: "change", target: "counter" },
            style: "ghost",
          },
        ]),
      ),
    ],
    state: advance(state, { step: "slot" }),
  };
};

/**
 * Date and service may arrive in either order; after either one, the next step
 * is whichever is still missing, then counters, then times. One rule written
 * once, which is what lets "Book → which day?" and "See services → pick one →
 * which day?" share a funnel instead of forking into two.
 */
const nextStep = (state: AssistantState): "date" | "service" | "counter" =>
  !state.date ? "date" : !state.serviceId ? "service" : "counter";

const advanceFunnel = async (
  state: AssistantState,
  salon: LoadedSalon,
  lead: string,
): Promise<TurnResult> => {
  switch (nextStep(state)) {
    case "date":
      return renderDates(state, salon, lead);
    case "service":
      return renderServices(state, salon, lead);
    case "counter":
      return renderCounters(state, salon, lead);
  }
};

/* --------------------------------------------------------------- the wallet */

export type WalletView = {
  signedIn: boolean;
  isFrozen: boolean;
  availableMinor: number;
  heldMinor: number;
};

export const readWallet = async (userId?: string): Promise<WalletView> => {
  if (!userId) {
    return {
      signedIn: false,
      isFrozen: false,
      availableMinor: 0,
      heldMinor: 0,
    };
  }

  const summary = await WalletService.getWalletSummary(userId);

  return {
    signedIn: true,
    isFrozen: summary.isFrozen,
    availableMinor: summary.availableMinor,
    heldMinor: summary.heldBalanceMinor,
  };
};

const TAKA_100 = 10000;

/** Nobody wants to be asked for ৳37. */
const roundUpToTaka100 = (minor: number): number =>
  Math.ceil(minor / TAKA_100) * TAKA_100;

const topupFor = (shortfallMinor: number): number =>
  Math.max(PaymentIntentService.MIN_TOPUP_MINOR, roundUpToTaka100(shortfallMinor));

/**
 * A wallet can never go negative, so "shortfall" here means one thing only: the
 * gap between what is available and the deposit this booking will hold. There
 * is no debt, and nothing in the chat may imply one.
 *
 * `approximate` is the early check fired the moment someone taps Book, before
 * the service — and so the exact deposit — is known. It quotes the salon's
 * cheapest deposit and says so.
 */
export const walletBlock = (
  wallet: WalletView,
  depositFromMinor: number,
  approximate: boolean,
): Block => {
  const shortfallMinor = Math.max(depositFromMinor - wallet.availableMinor, 0);
  const suggestedTopupMinor = shortfallMinor > 0 ? topupFor(shortfallMinor) : 0;

  const held = approximate
    ? `Deposits here start at ${formatBDT(depositFromMinor)}, held from your wallet when you book and returned when you turn up.`
    : `A ${formatBDT(depositFromMinor)} deposit is held from your wallet when you book and returned when you turn up.`;

  const note = !wallet.signedIn
    ? "Sign in when you are ready to book — the deposit comes out of your wallet."
    : wallet.isFrozen
      ? `Your wallet is on hold, so no deposit can be taken from it right now. Contact support to have it released.`
      : depositFromMinor <= 0
        ? `You have ${formatBDT(wallet.availableMinor)} available${wallet.heldMinor > 0 ? `, and ${formatBDT(wallet.heldMinor)} held against bookings` : ""}.`
        : shortfallMinor > 0
          ? `${held} You have ${formatBDT(wallet.availableMinor)}, so top up ${formatBDT(suggestedTopupMinor)} to finish.`
          : held;

  return walletStatus({
    signedIn: wallet.signedIn,
    isFrozen: wallet.isFrozen,
    availableMinor: wallet.availableMinor,
    heldMinor: wallet.heldMinor,
    depositFromMinor,
    shortfallMinor,
    suggestedTopupMinor,
    minTopupMinor: PaymentIntentService.MIN_TOPUP_MINOR,
    note,
  });
};

/** The early warning's way in, before there is a summary to book: it opens
 *  the wallet turn, whose payment prompt is a plain top-up. */
const topupChip = (shortfallMinor: number): QuickReply => ({
  // With top-ups paused the same tap only shows the wallet, so it says so.
  label: ASSISTANT_TOPUP_ENABLED
    ? `Top up ${formatBDT(topupFor(shortfallMinor))}`
    : "My wallet",
  action: { type: "wallet" },
  style: "primary",
  icon: "wallet",
});

/**
 * The top-up card. A shortfall of ৳30 still means topping up ৳100 — the
 * gateway refuses less — so the suggestion is never under the minimum, and
 * every preset offered is enough to finish the booking on its own.
 */
export const paymentPrompt = (
  shortfallMinor: number,
  canAutoConfirm: boolean,
): Block => {
  // The gateway is down: say where the wallet is instead of offering buttons
  // that would open a payment page that cannot finish.
  if (!ASSISTANT_TOPUP_ENABLED) return notice("info", COPY.topupPaused);

  const suggestedTopupMinor =
    shortfallMinor > 0
      ? topupFor(shortfallMinor)
      : PaymentIntentService.MIN_TOPUP_MINOR;

  const presets = Array.from(
    new Set([
      suggestedTopupMinor,
      ...TOPUP_PRESETS_MINOR.filter((minor) => minor >= suggestedTopupMinor),
    ]),
  ).sort((a, b) => a - b);

  return paymentPromptBlock({
    shortfallMinor,
    suggestedTopupMinor,
    minTopupMinor: PaymentIntentService.MIN_TOPUP_MINOR,
    presets,
    methods: PAYMENT_METHODS,
    // Nothing to book when nothing is short: the plain Confirm does that.
    canAutoConfirm: canAutoConfirm && shortfallMinor > 0,
  });
};

/**
 * The summary the customer is looking at, if its hold is still theirs: the
 * quote it was drawn with and when the hold lapses. Null whenever booking on
 * their behalf would be booking something they are no longer looking at.
 */
export const heldQuote = async (
  state: AssistantState,
  userId?: string,
): Promise<{ payload: ConfirmPayload; heldUntil: Date } | null> => {
  if (!userId || state.step !== "summary" || !state.slotId) return null;

  const payload = peekConfirm(state.quoteToken);
  if (!payload || payload.sid !== state.slotId || payload.uid !== userId) {
    return null;
  }

  const heldUntil = await heldUntilFor(state.slotId, userId);
  return heldUntil ? { payload, heldUntil } : null;
};

/** The prompt for wherever the customer is: against the held deposit at a
 *  live summary, as a plain top-up anywhere else. */
export const promptFor = async (
  state: AssistantState,
  userId: string | undefined,
  wallet: WalletView,
): Promise<Block> => {
  const quote = await heldQuote(state, userId);
  const shortfallMinor = quote
    ? Math.max(quote.payload.dm - wallet.availableMinor, 0)
    : 0;

  return paymentPrompt(shortfallMinor, quote !== null);
};

/* ------------------------------------------------------------- the handlers */

const handleBook = async (
  state: AssistantState,
  ctx: TurnContext,
): Promise<TurnResult> => {
  if (!state.salonId) return handleStart(state);

  const salon = await loadSalon(state.salonId);
  if (!salon) return salonGone(state);
  if (!salon.services.length || !salon.counters.length) {
    return notBookable(state, salon);
  }

  const cheapest = Math.min(...salon.services.map((s) => s.priceMinor));
  const depositFromMinor = resolveDepositMinor(salon, cheapest);
  const wallet = await readWallet(ctx.userId);
  const shortfallMinor = Math.max(depositFromMinor - wallet.availableMinor, 0);

  const opening: Block[] = [walletBlock(wallet, depositFromMinor, true)];

  // A guest is shown the times anyway and signs in at the summary. Making them
  // log in first loses the customer who only wanted to know if 6 pm was free.
  if (!wallet.signedIn) {
    opening.push(loginRequired(COPY.loginToBook, ASSISTANT_PATH));
  }

  if (wallet.isFrozen) {
    const text = `Your wallet is on hold, so I cannot start a booking at ${salon.name} yet.`;

    return {
      text,
      blocks: [
        ...opening,
        notice("warn", text),
        quickReplies([
          {
            label: "Another salon",
            action: { type: "find_nearby" },
            icon: "map-pin",
          },
          { label: "Start over", action: { type: "restart" }, style: "ghost" },
        ]),
      ],
      state: advance(state, { step: "salon" }),
    };
  }

  const dates = await renderDates(
    state,
    salon,
    `${salon.name}.`,
    wallet.signedIn && shortfallMinor > 0 ? [topupChip(shortfallMinor)] : [],
  );

  return { ...dates, blocks: [...opening, ...dates.blocks] };
};

const handleShowServices = async (
  state: AssistantState,
): Promise<TurnResult> => {
  if (!state.salonId) return handleStart(state);

  const salon = await loadSalon(state.salonId);
  if (!salon) return salonGone(state);
  if (!salon.services.length || !salon.counters.length) {
    return notBookable(state, salon);
  }

  return renderServices(state, salon, `${salon.name}.`);
};

const handleChooseDate = async (
  state: AssistantState,
  action: Extract<AssistantAction, { type: "choose_date" }>,
): Promise<TurnResult> => {
  if (!state.salonId) return handleStart(state);

  const salon = await loadSalon(state.salonId);
  if (!salon) return salonGone(state);

  const window = bookingWindow();
  const inWindow =
    isYmd(action.date) &&
    action.date >= window.today &&
    action.date <= window.lastDay;

  if (inWindow) {
    const day = toCalendarDate(action.date);
    const slots = await loadOpenSlots({
      salonId: salon.id,
      from: day,
      to: day,
      ...(state.serviceId ? { serviceId: state.serviceId } : {}),
    });

    if (slots.length > 0) {
      return advanceFunnel(
        advance(state, { date: action.date }),
        salon,
        `${dateLabel(action.date, window.today)} at ${salon.name}.`,
      );
    }
  }

  return because(
    await renderDates(clearFrom(state, "date"), salon, ""),
    COPY.badDate,
    "date_picker",
  );
};

const handleChooseService = async (
  state: AssistantState,
  action: Extract<AssistantAction, { type: "choose_service" }>,
): Promise<TurnResult> => {
  if (!state.salonId) return handleStart(state);

  const salon = await loadSalon(state.salonId);
  if (!salon) return salonGone(state);

  const service = salon.services.find((s) => s.id === action.serviceId);

  if (!service) {
    return because(
      await renderServices(clearFrom(state, "serviceId"), salon, ""),
      COPY.staleTap,
      "service_picker",
    );
  }

  const depositMinor = resolveDepositMinor(salon, service.priceMinor);
  const chosen = advance(state, { serviceId: service.id });

  // The picker never offers a service the chosen day cannot take, but a stale
  // tab still can. Keep the service, re-ask the day, and say plainly why —
  // blaming a race that did not happen is worse than no message at all.
  if (state.date) {
    const day = toCalendarDate(state.date);
    const sameDay = await loadOpenSlots({
      salonId: salon.id,
      from: day,
      to: day,
      serviceId: service.id,
    });

    if (sameDay.length === 0) {
      return because(
        await renderDates(clearFrom(chosen, "date"), salon, ""),
        `${service.name} is not free on ${dateLabel(state.date)}. Here are the days it is.`,
        "date_picker",
      );
    }
  }

  return advanceFunnel(
    chosen,
    salon,
    `${service.name}, ${formatBDT(service.priceMinor)} with a ${formatBDT(depositMinor)} deposit.`,
  );
};

const handleChooseCounter = async (
  state: AssistantState,
  action: Extract<AssistantAction, { type: "choose_counter" }>,
): Promise<TurnResult> => {
  if (!state.salonId) return handleStart(state);

  const salon = await loadSalon(state.salonId);
  if (!salon) return salonGone(state);
  if (!state.date || !state.serviceId) return advanceFunnel(state, salon, "");

  const day = toCalendarDate(state.date);
  const slots = await loadOpenSlots({
    salonId: salon.id,
    from: day,
    to: day,
    serviceId: state.serviceId,
  });

  const picked = counterOptions(slots, salon.counters).find(
    (option) => option.counter.id === action.counterId,
  );

  if (!picked) {
    return because(
      await renderCounters(clearFrom(state, "counterId"), salon, ""),
      COPY.slotsGone,
      "counter_picker",
    );
  }

  return renderSlots(
    advance(state, { counterId: picked.counter.id }),
    salon,
    `${picked.counter.name}.`,
    { counter: picked.counter, slots: picked.slots },
  );
};

const handleChooseSlot = async (
  state: AssistantState,
  ctx: TurnContext,
  action: Extract<AssistantAction, { type: "choose_slot" }>,
): Promise<TurnResult> => {
  if (!state.salonId) return handleStart(state);

  const salon = await loadSalon(state.salonId);
  if (!salon) return salonGone(state);

  const service = salon.services.find((s) => s.id === state.serviceId);
  const counter = salon.counters.find((c) => c.id === state.counterId);

  if (!state.date || !service || !counter) {
    return advanceFunnel(
      service ? state : clearFrom(state, "serviceId"),
      salon,
      "",
    );
  }

  const slot = await prisma.slot.findUnique({ where: { id: action.slotId } });

  // The same four checks `bookAppointment` enforces, plus the clock. Offering a
  // slot the booking endpoint would then refuse is the one failure this whole
  // funnel exists to avoid.
  const usable =
    slot !== null &&
    slot.status === "AVAILABLE" &&
    !slot.isBooked &&
    slot.salonId === salon.id &&
    (slot.serviceId === null || slot.serviceId === service.id) &&
    (slot.counterId === null || slot.counterId === counter.id) &&
    toYmd(slot.date) === state.date &&
    !hasSlotStarted(slot);

  if (!slot || !usable) {
    return because(
      await renderSlots(clearFrom(state, "slotId"), salon, ""),
      COPY.slotTaken,
      "slot_picker",
    );
  }

  // Signed in, the figures come from the booking path itself rather than from
  // a second implementation of it: `quoteBooking` runs every check
  // `bookAppointment` runs, in the same order, with the same messages. A
  // failure here is a slot the booking endpoint would have refused, so it is
  // answered as a taken time rather than shown a price.
  let quote: BookingQuote | null = null;

  if (ctx.userId) {
    try {
      quote = await AppointmentService.quoteBooking(ctx.userId, {
        salonId: salon.id,
        serviceId: service.id,
        counterId: counter.id,
        slotId: slot.id,
        staffId: state.staffId ?? null,
      });
    } catch (error) {
      return because(
        await renderSlots(clearFrom(state, "slotId"), salon, ""),
        error instanceof ApiError ? error.message : COPY.slotTaken,
        "slot_picker",
      );
    }
  }

  const priceMinor = quote?.totalMinor ?? service.priceMinor;
  const depositMinor = quote?.depositMinor ?? resolveDepositMinor(salon, priceMinor);
  const dueAtSalonMinor = priceMinor - depositMinor;

  // Free cancellation closes `cancellationWindowMin` before the chair is due —
  // the same arithmetic `isWithinFreeCancellation` does after booking.
  const freeUntil = new Date(
    slotStartsAt(slot).getTime() - salon.cancellationWindowMin * 60 * 1000,
  );
  const freeCancellationUntil =
    freeUntil.getTime() > Date.now() ? freeUntil.toISOString() : null;

  const wallet = await readWallet(ctx.userId);
  // Recomputed against the exact deposit: the check at the top of the funnel
  // was a warning, this one is the figure.
  const shortfallMinor = Math.max(depositMinor - wallet.availableMinor, 0);

  const handoffUrl = `/salons/${salon.id}/book?service=${service.id}&counter=${counter.id}&slot=${slot.id}&date=${state.date}`;

  // A move is a new booking plus a cancellation, so what that cancellation
  // costs belongs on the card before the tap, quoted by the same function the
  // cancel will apply. Null when the old booking can no longer be moved.
  const move = await rescheduleInfo(ctx.userId, state.rescheduleOf);

  // Hold the chair only for somebody who could actually take it. A guest has
  // no wallet and no account, so holding for them would keep a slot off the
  // market on behalf of a customer who may never sign in.
  let holdExpiresAt: string | null = null;
  let confirmToken: string | null = null;

  if (quote && ctx.userId && ctx.conversationId) {
    const held = await holdSlot(slot.id, ctx.userId, HOLD_MINUTES);

    if (!held) {
      // Somebody else got there in the seconds since the list was drawn.
      return because(
        await renderSlots(clearFrom(state, "slotId"), salon, ""),
        COPY.slotHeld,
        "slot_picker",
      );
    }

    const expiresAt = Date.now() + HOLD_MINUTES * 60_000;
    holdExpiresAt = new Date(expiresAt).toISOString();
    confirmToken = signConfirm({
      v: 1,
      cid: ctx.conversationId,
      uid: ctx.userId,
      sid: slot.id,
      svc: service.id,
      cnt: counter.id,
      ...(state.staffId ? { stf: state.staffId } : {}),
      pm: priceMinor,
      dm: depositMinor,
      exp: expiresAt,
    });
  }

  const blocks: Block[] = [
    bookingSummary({
      salon: {
        id: salon.id,
        name: salon.name,
        area: salon.area,
        address: salon.address,
        phone: salon.phone,
      },
      service: {
        id: service.id,
        name: service.name,
        category: service.category,
        priceMinor,
        duration: service.duration,
      },
      counter: { id: counter.id, name: counter.name, code: counter.code },
      // The funnel does not pick a stylist; Phase 7 may.
      staff: null,
      slot: {
        id: slot.id,
        date: state.date,
        startTime: slot.startTime,
        endTime: slot.endTime,
      },
      priceMinor,
      depositMinor,
      dueAtSalonMinor,
      freeCancellationUntil,
      cancellationWindowMin: salon.cancellationWindowMin,
      wallet: {
        signedIn: wallet.signedIn,
        availableMinor: wallet.availableMinor,
        shortfallMinor,
      },
      handoffUrl,
      // The Confirm button appears off this flag. A wallet that cannot cover
      // the deposit still gets the card and the token — the button is there,
      // disabled behind the shortfall, rather than the whole path vanishing.
      canConfirmInChat: confirmToken !== null,
      ...(confirmToken ? { confirmToken } : {}),
      ...(holdExpiresAt ? { holdExpiresAt } : {}),
      ...(move ? { reschedule: move } : {}),
    }),
  ];

  if (state.rescheduleOf && !move) {
    blocks.push(
      notice(
        "info",
        "Your earlier booking can no longer be changed here, so this would be a new booking alongside it.",
      ),
    );
  } else if (move && move.penaltyMinor > 0) {
    blocks.push(
      notice(
        "warn",
        `Moving costs ${formatBDT(move.penaltyMinor)}: your ${move.label} booking is inside its free-cancellation window, so that much of its ${formatBDT(move.depositMinor)} deposit is kept when it is cancelled.`,
      ),
    );
  }

  if (wallet.signedIn && shortfallMinor > 0) {
    // "৳30 short of the ৳30 deposit" is true and reads like a mistake, so an
    // empty wallet gets said plainly instead.
    const gap =
      wallet.availableMinor === 0
        ? `Your wallet is empty and this booking holds a ${formatBDT(depositMinor)} deposit.`
        : `Your wallet is ${formatBDT(shortfallMinor)} short of the ${formatBDT(depositMinor)} deposit.`;

    blocks.push(
      notice(
        "warn",
        holdExpiresAt
          ? `${gap} Top up and the Confirm button opens — I am holding this time for ${HOLD_MINUTES} minutes.`
          : `${gap} Top up first — this time stays open unless someone else takes it.`,
      ),
    );

    // The top-up sits right under the card it unblocks. A frozen wallet cannot
    // take a deposit whatever is in it, so it is not asked for money.
    if (!wallet.isFrozen) {
      blocks.push(paymentPrompt(shortfallMinor, confirmToken !== null));
    }
  }

  if (!wallet.signedIn) {
    // Land them back on the review page with the selection intact.
    blocks.push(
      loginRequired("Sign in to take this time.", handoffUrl),
    );
  }

  blocks.push(
    quickReplies(
      funnelChips(state, [
        {
          label: "Change time",
          action: { type: "change", target: "slot" },
          style: "ghost",
        },
      ]),
    ),
  );

  const dueLine =
    dueAtSalonMinor > 0
      ? `${formatBDT(depositMinor)} held from your wallet, ${formatBDT(dueAtSalonMinor)} at the salon.`
      : `${formatBDT(depositMinor)} held from your wallet, nothing left to pay at the salon.`;

  const holdLine = holdExpiresAt
    ? ` I am holding this time for ${HOLD_MINUTES} minutes — tap Confirm and it is yours.`
    : "";

  // Set after `advance`, which drops the quote of whatever slot came before.
  const next = advance(state, { step: "summary", slotId: slot.id });
  if (state.rescheduleOf && !move) delete next.rescheduleOf;

  const moveLine = move
    ? `Moving your ${move.label} booking. ` +
      (move.penaltyMinor > 0
        ? `Cancelling the old one keeps ${formatBDT(move.penaltyMinor)} of its deposit. `
        : "Cancelling the old one is free. ")
    : "";
  if (confirmToken) next.quoteToken = confirmToken;
  else delete next.quoteToken;

  return {
    text: `${moveLine}${service.name} at ${salon.name}, ${dateLabel(state.date)} at ${slot.startTime}. ${formatBDT(priceMinor)} in total: ${dueLine}${holdLine}`,
    blocks,
    state: next,
  };
};

const CHANGE_FIELD = {
  salon: "salonId",
  date: "date",
  service: "serviceId",
  counter: "counterId",
  slot: "slotId",
} as const;

const handleChange = async (
  state: AssistantState,
  target: ChangeTarget,
): Promise<TurnResult> => {
  const cleared = clearFrom(state, CHANGE_FIELD[target]);

  // The salon's "picker" is the list the customer came from.
  if (target === "salon") {
    return handleFindNearby(advance(cleared, { step: "discover" }), {
      type: "find_nearby",
    });
  }

  if (!cleared.salonId) return handleStart(cleared);

  const salon = await loadSalon(cleared.salonId);
  if (!salon) return salonGone(cleared);

  switch (target) {
    case "date":
      return renderDates(cleared, salon, "");
    case "service":
      return renderServices(cleared, salon, "");
    case "counter":
      return renderCounters(cleared, salon, "");
    case "slot":
      return renderSlots(cleared, salon, "");
  }
};

const handleWallet = async (
  state: AssistantState,
  ctx: TurnContext,
): Promise<TurnResult> => {
  const wallet = await readWallet(ctx.userId);

  if (!wallet.signedIn) {
    return {
      text: "Sign in and I will show you your wallet.",
      blocks: [
        walletBlock(wallet, 0, false),
        loginRequired(COPY.loginToPay, ASSISTANT_PATH),
        quickReplies([
          {
            label: "Salons near me",
            action: { type: "find_nearby" },
            icon: "map-pin",
          },
        ]),
      ],
      state,
    };
  }

  const held =
    wallet.heldMinor > 0
      ? ` ${formatBDT(wallet.heldMinor)} is held against bookings you have not attended yet.`
      : "";

  return {
    text: `You have ${formatBDT(wallet.availableMinor)} available to spend.${held}`,
    blocks: [
      walletBlock(wallet, 0, false),
      // At a held summary this is "Top up & book"; anywhere else, a top-up.
      ...(wallet.isFrozen ? [] : [await promptFor(state, ctx.userId, wallet)]),
      quickReplies([
        {
          label: "Salons near me",
          action: { type: "find_nearby" },
          icon: "map-pin",
        },
      ]),
    ],
    state,
  };
};

/** The wallet and nothing else — what "check my payment" means when this chat
 *  has no top-up in flight. */
export const walletOnly = async (
  state: AssistantState,
  ctx: TurnContext,
): Promise<TurnResult> => {
  const wallet = await readWallet(ctx.userId);

  return {
    text: wallet.signedIn
      ? `You have ${formatBDT(wallet.availableMinor)} available to spend.`
      : "Sign in and I will show you your wallet.",
    blocks: [walletBlock(wallet, 0, false)],
    state,
  };
};

const handleRestart = (state: AssistantState): TurnResult => {
  // The location is the one thing worth carrying: it was the customer's
  // deliberate answer, not part of the draft we are throwing away.
  const fresh: AssistantState = {
    step: "greeting",
    ...(state.location ? { location: state.location } : {}),
    // A payment already on its way is not part of the draft: the chat must
    // still be able to say when it lands. Only its "and book" half goes.
    ...(state.pendingTopup
      ? { pendingTopup: withoutAutoConfirm(state.pendingTopup) }
      : {}),
  };

  return {
    text: COPY.greeting,
    blocks: startBlocks(),
    state: fresh,
  };
};

const handleBack = async (state: AssistantState): Promise<TurnResult> => {
  // Inside the funnel, "Back" is "Change the thing before this one" — the same
  // clearing, aimed one step upstream.
  const target = BACK_TARGET[state.step];
  if (target) return handleChange(state, target);

  const previous = PREVIOUS_STEP[state.step];

  if (!previous) return handleStart(state);
  if (previous === "greeting") return handleStart(state);

  // discover: re-emit the list the customer came from.
  return handleFindNearby(advance(state, { step: "discover" }), {
    type: "find_nearby",
  });
};

/* -------------------------------------------------------------- the switch */

/** Where the customer actually is, drawn again. Every branch is a renderer, so
 *  this can never re-enter an action handler and bounce back here. */
export const renderCurrent = async (
  state: AssistantState,
): Promise<TurnResult> => {
  if (state.step === "discover") {
    return handleFindNearby(state, { type: "find_nearby" });
  }

  if (!state.salonId) return handleStart(state);

  if (state.step === "salon") {
    return handleChooseSalon(state, {
      type: "choose_salon",
      salonId: state.salonId,
    });
  }

  const salon = await loadSalon(state.salonId);
  if (!salon) return salonGone(state);

  switch (state.step) {
    case "date":
      return renderDates(state, salon, "");
    case "service":
      return renderServices(state, salon, "");
    case "counter":
      return renderCounters(state, salon, "");
    // A summary is rebuilt as the slot list it came from: re-quoting a price
    // for a slot we have not re-checked would be a promise we cannot keep.
    case "slot":
    case "summary":
      return renderSlots(state, salon, "");
    default:
      return handleStart(state);
  }
};

/** A tap that does not belong to the current step. Normal for a stale tab, so
 *  it is answered with where we are, never thrown. */
const handleStale = async (state: AssistantState): Promise<TurnResult> => {
  const current = await renderCurrent(state);

  return {
    ...current,
    text: COPY.staleTap,
    blocks: [notice("info", COPY.staleTap), ...current.blocks],
  };
};

/**
 * Walking away from a held time gives it straight back, rather than leaving it
 * off the market for the rest of the window. Best effort by design: a hold
 * nobody releases expires by itself, because expiry is in the claim predicate.
 */
const LEAVES_THE_SUMMARY: AssistantAction["type"][] = [
  "change",
  "restart",
  "choose_salon",
  "find_nearby",
  "search_salons",
  "back",
  // Both start a new draft at another salon/service.
  "reschedule",
  "book_usual",
];

const releaseHeldSlot = async (
  state: AssistantState,
  action: AssistantAction,
  ctx: TurnContext,
) => {
  if (!ctx.userId || !state.slotId || state.step !== "summary") return;

  const leaving =
    LEAVES_THE_SUMMARY.includes(action.type) ||
    // Re-picking a time from the summary: the old chair is no longer wanted.
    (action.type === "choose_slot" && action.slotId !== state.slotId);

  if (leaving) await releaseSlot(state.slotId, ctx.userId);
};

/**
 * "Top up & book" consented to *this* summary. Once a turn moves the customer
 * off it — another time, another salon, back, start over — the booking half of
 * that consent is withdrawn, so a payment landing later cannot take a slot they
 * walked away from. The money half is untouched.
 */
const keepConsentHonest = (
  before: AssistantState,
  result: TurnResult,
): TurnResult => {
  const pending = result.state.pendingTopup;
  if (!pending?.autoConfirm) return result;

  const stillThere =
    result.state.step === "summary" && result.state.slotId === before.slotId;
  if (stillThere) return result;

  return {
    ...result,
    state: { ...result.state, pendingTopup: withoutAutoConfirm(pending) },
  };
};

export const runAction = async (
  state: AssistantState,
  action: AssistantAction,
  ctx: TurnContext = {},
): Promise<TurnResult> => {
  const result = keepConsentHonest(state, await dispatchAction(state, action, ctx));
  return settle(await followWish(action, result, ctx));
};

const withoutWish = (
  state: AssistantState,
  ...fields: Array<keyof NonNullable<AssistantState["wish"]>>
): AssistantState => {
  if (!state.wish) return state;
  const wish = { ...state.wish };
  for (const field of fields) delete wish[field];
  const next: AssistantState = { ...state, wish };
  if (Object.keys(wish).length === 0) delete next.wish;
  return next;
};

const matchesWish = (
  service: ServiceOption,
  wish: NonNullable<AssistantState["wish"]>,
): boolean => {
  const name = service.name.toLowerCase();
  return (
    (wish.categories ?? []).includes(service.category) ||
    (wish.serviceTerms ?? []).some((term) => name.includes(term.toLowerCase()))
  );
};

/**
 * A typed "haircut tomorrow evening" answers questions the funnel has not
 * asked yet. When it gets there, this answers them — once each — with the same
 * actions a tap would send, so the result is exactly what tapping would show.
 * A day that has nothing free is said out loud and the picker left open.
 */
const followWish = async (
  action: AssistantAction,
  first: TurnResult,
  ctx: TurnContext,
): Promise<TurnResult> => {
  let result = first;

  // A near-me search that had to ask for a location first.
  const pending = result.state.wish?.search;
  if (action.type === "set_location" && pending && result.state.location) {
    const parsed = AssistantValidation.actionSchema.safeParse(pending);
    const state = withoutWish(result.state, "search");
    result =
      parsed.success && parsed.data.type === "search_salons"
        ? await dispatchAction(state, parsed.data, ctx)
        : { ...result, state };
  }

  for (let round = 0; round < 3; round += 1) {
    const { state } = result;
    const wish = state.wish;
    if (!wish) break;

    if (state.step === "date" && wish.date) {
      const cleared = withoutWish(state, "date");
      const picker = result.blocks.find((b) => b.type === "date_picker");
      const offered =
        picker?.type === "date_picker" && picker.dates.some((d) => d.date === wish.date);
      if (offered) {
        result = await dispatchAction(cleared, { type: "choose_date", date: wish.date }, ctx);
        continue;
      }
      const text = `Nothing is free on ${dateLabel(wish.date)} here. These days still have times.`;
      result = { text, blocks: [notice("info", text), ...result.blocks], state: cleared };
      continue;
    }

    if (state.step === "service" && (wish.categories?.length || wish.serviceTerms?.length)) {
      const cleared = withoutWish(state, "categories", "serviceTerms");
      const picker = result.blocks.find((b) => b.type === "service_picker");
      const matches =
        picker?.type === "service_picker" ? picker.services.filter((s) => matchesWish(s, wish)) : [];
      // Two haircuts is a real choice; only an unambiguous match is taken.
      if (matches.length === 1) {
        result = await dispatchAction(cleared, { type: "choose_service", serviceId: matches[0].id }, ctx);
        continue;
      }
      result = { ...result, state: cleared };
      continue;
    }

    break;
  }

  return result;
};

/** Scrolls a slot picker to the part of day the customer typed. */
const focusSlots = (result: TurnResult): TurnResult => {
  const wish = result.state.wish;
  if (!wish?.partOfDay && !wish?.after) return result;
  const focus = bandFor(wish.partOfDay);
  const picker = result.blocks.find((b) => b.type === "slot_picker");
  // Asked for the evening and there is none: say so, rather than scroll to a
  // band that is not there and leave them wondering.
  const missing =
    focus &&
    picker?.type === "slot_picker" &&
    !picker.groups.some((g) => g.label === focus && g.slots.length > 0)
      ? `Nothing is free in the ${focus.toLowerCase()} that day. These are the times that are.`
      : null;
  return {
    ...result,
    blocks: [
      ...(missing ? [notice("info", missing)] : []),
      ...result.blocks.map((block) =>
        block.type === "slot_picker"
          ? { ...block, focus: missing ? null : focus, after: wish.after ?? null }
          : block,
      ),
    ],
  };
};

/** The finishing touches every turn gets — also applied by the text turn to
 *  a step it redraws without an action. */
export const settle = (result: TurnResult): TurnResult => remember(focusSlots(result));

/** What the last picker offered, so "the first one" or "5:45" can be matched
 *  against it without a model. A turn with no picker keeps the old list. */
const remember = (result: TurnResult): TurnResult => {
  let lastOptions: AssistantState["lastOptions"];

  for (const block of result.blocks) {
    if (block.type === "salon_carousel") {
      lastOptions = {
        kind: "salon",
        items: block.salons.map((s) => ({ id: s.id, label: s.name, priceMinor: s.priceFromMinor })),
      };
    } else if (block.type === "date_picker") {
      lastOptions = { kind: "date", items: block.dates.map((d) => ({ id: d.date, label: d.label })) };
    } else if (block.type === "service_picker") {
      lastOptions = {
        kind: "service",
        items: block.services.map((s) => ({
          id: s.id,
          label: s.name,
          priceMinor: s.priceMinor,
          category: s.category,
        })),
      };
    } else if (block.type === "counter_picker") {
      lastOptions = { kind: "counter", items: block.counters.map((c) => ({ id: c.id, label: c.name })) };
    } else if (block.type === "slot_picker") {
      // Over the cap, the band the customer asked for is the part worth keeping.
      const groups = [...block.groups].sort(
        (a, b) => Number(b.label === block.focus) - Number(a.label === block.focus),
      );
      lastOptions = {
        kind: "slot",
        items: groups
          .flatMap((g) => g.slots.map((s) => ({ id: s.id, label: s.startTime, time: s.startTime.slice(0, 5) })))
          .slice(0, 20)
          .sort((a, b) => a.time.localeCompare(b.time)),
      };
    }
  }

  if (!lastOptions) return result;
  return {
    ...result,
    state: { ...result.state, lastOptions: { ...lastOptions, items: lastOptions.items.slice(0, 20) } },
  };
};

const dispatchAction = async (
  state: AssistantState,
  action: AssistantAction,
  ctx: TurnContext,
): Promise<TurnResult> => {
  if (!ALLOWED_ACTIONS[state.step].includes(action.type)) {
    return handleStale(state);
  }

  await releaseHeldSlot(state, action, ctx);

  switch (action.type) {
    case "start":
      return withReturningExtras(handleStart(state), ctx.userId);
    case "find_nearby":
      return handleFindNearby(state, action);
    case "set_location": {
      // A saved location opens the chat straight onto the carousel, so that
      // first turn is where a returning customer's shortcuts have to appear.
      const located = await handleSetLocation(state, action);
      return ctx.opening ? withReturningExtras(located, ctx.userId) : located;
    }
    case "search_salons":
      return handleSearchSalons(state, action);
    case "choose_salon":
      return handleChooseSalon(state, action);
    case "change_location":
      return handleChangeLocation(state);
    case "book":
      return handleBook(state, ctx);
    case "show_services":
      return handleShowServices(state);
    case "choose_date":
      return handleChooseDate(state, action);
    case "choose_service":
      return handleChooseService(state, action);
    case "choose_counter":
      return handleChooseCounter(state, action);
    case "choose_slot":
      return handleChooseSlot(state, ctx, action);
    case "change":
      return handleChange(state, action.target);
    case "wallet":
      return handleWallet(state, ctx);
    case "check_payment":
      return walletOnly(state, ctx);
    case "restart":
      return withReturningExtras(handleRestart(state), ctx.userId);
    case "back":
      return handleBack(state);
    case "my_bookings":
      return AssistantManage.handleMyBookings(state, ctx, action);
    case "cancel_booking":
      return AssistantManage.handleCancelBooking(state, ctx, action);
    case "cancel_confirm":
      return AssistantManage.handleCancelConfirm(state, ctx, action);
    case "reschedule":
      return AssistantManage.handleReschedule(state, ctx, action);
    case "book_usual":
      return AssistantManage.handleBookUsual(state, ctx, action);
    case "rate_booking":
      return AssistantManage.handleRateBooking(state, ctx, action);
  }
};
