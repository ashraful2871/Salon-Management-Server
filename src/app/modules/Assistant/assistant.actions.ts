import prisma from "../../shared/prisma";
import { formatBDT } from "../../utils/money";
import { isOpenNow } from "../AI-Suggestion/ai.search";
import { SalonService } from "../Salon/salon.service";
import { BD_BOUNDS, SalonValidation } from "../Salon/salon.validation";
import {
  Block,
  QuickReply,
  SalonCard,
  SalonPolicy,
  locationRequest,
  notice,
  quickReplies,
  salonCarousel,
  salonDetails,
} from "./assistant.blocks";
import {
  COPY,
  LOCATION_PRECISION,
  NEARBY_RADIUS_KM,
  NEARBY_RADIUS_WIDE_KM,
  SALON_CARDS,
} from "./assistant.constants";
import {
  ALLOWED_ACTIONS,
  AssistantState,
  PREVIOUS_STEP,
  advance,
} from "./assistant.state";

/**
 * Every turn in this phase is deterministic: an action comes in, the server
 * changes state, builds blocks and answers. No model call anywhere. Free text
 * arrives later by mapping onto these same actions.
 */
export type AssistantAction =
  | { type: "start" }
  | { type: "find_nearby"; page?: number }
  | { type: "set_location"; lat: number; lng: number; label?: string }
  | { type: "search_salons"; query: string; page?: number }
  | { type: "choose_salon"; salonId: string }
  // The "Change location" chip: re-asks, rather than re-running the search from
  // the location we already hold.
  | { type: "change_location" }
  // Stubs until Phase 2 owns the booking funnel; they answer with a notice so
  // the chip on the salon card is real rather than dead.
  | { type: "book" }
  | { type: "show_services" }
  | { type: "restart" }
  | { type: "back" };

export type TurnResult = {
  text: string;
  blocks: Block[];
  state: AssistantState;
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
    // 💳 My wallet — Phase 2 · 📅 My bookings — Phase 7
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

/** The no-location fallback, and the seed of free-text search in Phase 6. */
const handleSearchSalons = async (
  state: AssistantState,
  action: Extract<AssistantAction, { type: "search_salons" }>,
): Promise<TurnResult> => {
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

const handleChooseSalon = async (
  state: AssistantState,
  action: Extract<AssistantAction, { type: "choose_salon" }>,
): Promise<TurnResult> => {
  const salon = await prisma.salon.findFirst({
    where: { id: action.salonId, status: "ACTIVE", isDeleted: false },
    include: {
      services: { where: { isActive: true, isDeleted: false } },
      counters: { where: { isActive: true, isDeleted: false } },
    },
  });

  if (!salon) {
    return {
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
    };
  }

  const card = toCard(salon as unknown as SalonRow);
  const policy: SalonPolicy = {
    depositMinor: salon.depositMinor,
    depositPercent: salon.depositPercent,
    cancellationWindowMin: salon.cancellationWindowMin,
    phone: salon.phone,
    address: salon.address,
  };

  const actions: QuickReply[] = [
    // Booking lands in Phase 2; until then both stubs answer with a notice.
    {
      label: "Book appointment",
      action: { type: "book" },
      style: "primary",
      icon: "calendar",
    },
    { label: "See services", action: { type: "show_services" }, icon: "scissors" },
    // Call and Directions are handled client-side from policy.phone and the
    // salon's coordinates — no action round trip.
    { label: "Another salon", action: { type: "find_nearby" }, icon: "map-pin" },
  ];

  return {
    text: `${salon.name}, ${salon.area}. ${COPY.bookingSoon}`,
    blocks: [
      salonDetails(card, policy, actions),
      notice("info", COPY.bookingSoon),
    ],
    state: advance(state, { step: "salon", salonId: salon.id }),
  };
};

/** Phase 2 replaces this with the booking funnel. Until then the chip is honest
 *  about what it does instead of quietly doing nothing. */
const handleBookingStub = async (
  state: AssistantState,
): Promise<TurnResult> => {
  const current =
    state.salonId !== undefined
      ? await handleChooseSalon(state, {
          type: "choose_salon",
          salonId: state.salonId,
        })
      : handleStart(state);

  return { ...current, text: COPY.bookingSoon };
};

const handleRestart = (state: AssistantState): TurnResult => {
  // The location is the one thing worth carrying: it was the customer's
  // deliberate answer, not part of the draft we are throwing away.
  const fresh: AssistantState = {
    step: "greeting",
    ...(state.location ? { location: state.location } : {}),
  };

  return {
    text: COPY.greeting,
    blocks: startBlocks(),
    state: fresh,
  };
};

const handleBack = async (state: AssistantState): Promise<TurnResult> => {
  const previous = PREVIOUS_STEP[state.step];

  if (!previous) return handleStart(state);
  if (previous === "greeting") return handleStart(state);

  // discover: re-emit the list the customer came from.
  return handleFindNearby(advance(state, { step: "discover" }), {
    type: "find_nearby",
  });
};

/* -------------------------------------------------------------- the switch */

/** A tap that does not belong to the current step. Normal for a stale tab, so
 *  it is answered with where we are, never thrown. */
const handleStale = async (state: AssistantState): Promise<TurnResult> => {
  const current: TurnResult =
    state.step === "salon" && state.salonId
      ? await handleChooseSalon(state, {
          type: "choose_salon",
          salonId: state.salonId,
        })
      : state.step === "discover"
        ? await handleFindNearby(state, { type: "find_nearby" })
        : handleStart(state);

  return {
    ...current,
    text: COPY.staleTap,
    blocks: [notice("info", COPY.staleTap), ...current.blocks],
  };
};

export const runAction = async (
  state: AssistantState,
  action: AssistantAction,
): Promise<TurnResult> => {
  if (!ALLOWED_ACTIONS[state.step].includes(action.type)) {
    return handleStale(state);
  }

  switch (action.type) {
    case "start":
      return handleStart(state);
    case "find_nearby":
      return handleFindNearby(state, action);
    case "set_location":
      return handleSetLocation(state, action);
    case "search_salons":
      return handleSearchSalons(state, action);
    case "choose_salon":
      return handleChooseSalon(state, action);
    case "change_location":
      return handleChangeLocation(state);
    case "book":
    case "show_services":
      return handleBookingStub(state);
    case "restart":
      return handleRestart(state);
    case "back":
      return handleBack(state);
  }
};
