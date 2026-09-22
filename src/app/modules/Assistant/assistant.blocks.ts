import type { AssistantAction } from "./assistant.actions";

/**
 * Blocks are the assistant's whole vocabulary for the screen. The server builds
 * them as JSON and the frontend maps `type` to a component — the model never
 * writes markup, so a bad generation can only ever be bad copy, never a broken
 * or hostile page.
 *
 * The union is declared in full here from the start; later phases add builders,
 * not new shapes to discover.
 */
export type Block =
  | { type: "quick_replies"; options: QuickReply[] }
  | { type: "location_request"; reason: string; canSkip: boolean }
  | { type: "salon_carousel"; salons: SalonCard[]; nextPage?: AssistantAction }
  | {
      type: "salon_details";
      salon: SalonCard;
      policy: SalonPolicy;
      actions: QuickReply[];
    }
  | { type: "notice"; tone: "info" | "warn" | "error"; text: string }
  | { type: "login_required"; reason: string; returnPath: string };
// Phase 2: wallet_status · date_picker · service_picker · counter_picker · slot_picker · booking_summary
// Phase 4: booking_confirmed
// Phase 5: payment_prompt

/** `icon` is a name ("map-pin", "scissors", "wallet"), never markup — the
 *  frontend maps it to a Lucide icon. */
export type QuickReply = {
  label: string;
  action: AssistantAction;
  style?: "primary" | "ghost";
  icon?: string;
};

export type SalonCard = {
  id: string;
  name: string;
  area: string;
  city: string;
  image: string | null;
  rating: number;
  totalReviews: number;
  /** null when we have no location to measure from. */
  distanceMeters: number | null;
  /** Cheapest active service; null when the salon lists none. */
  priceFromMinor: number | null;
  /** null when the salon has not published hours — unknown is not closed. */
  openNow: boolean | null;
  serviceCount: number;
  counterCount: number;
  /** Why this salon is in the list — "1.2 km away", "Open now", "From ৳120". */
  reasons: string[];
};

export type SalonPolicy = {
  depositMinor: number;
  depositPercent: number | null;
  cancellationWindowMin: number;
  phone: string;
  address: string;
};

export const quickReplies = (options: QuickReply[]): Block => ({
  type: "quick_replies",
  options,
});

export const locationRequest = (reason: string, canSkip: boolean): Block => ({
  type: "location_request",
  reason,
  canSkip,
});

export const salonCarousel = (
  salons: SalonCard[],
  nextPage?: AssistantAction,
): Block => ({
  type: "salon_carousel",
  salons,
  ...(nextPage ? { nextPage } : {}),
});

export const salonDetails = (
  salon: SalonCard,
  policy: SalonPolicy,
  actions: QuickReply[],
): Block => ({ type: "salon_details", salon, policy, actions });

export const notice = (
  tone: "info" | "warn" | "error",
  text: string,
): Block => ({ type: "notice", tone, text });

export const loginRequired = (reason: string, returnPath: string): Block => ({
  type: "login_required",
  reason,
  returnPath,
});
