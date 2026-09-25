import type { AssistantAction } from "./assistant.actions";
import type { DateOption, SlotGroup } from "./assistant.availability";

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
  | { type: "login_required"; reason: string; returnPath: string }
  | {
      type: "wallet_status";
      signedIn: boolean;
      isFrozen: boolean;
      availableMinor: number;
      heldMinor: number;
      /** The cheapest deposit this salon could ask for. Zero on the standalone
       *  "My wallet" chip, where no booking is in play. */
      depositFromMinor: number;
      /** What is missing, and nothing else: a wallet can never go negative, so
       *  there is no such thing as an outstanding balance here. */
      shortfallMinor: number;
      suggestedTopupMinor: number;
      minTopupMinor: number;
      note: string;
    }
  | {
      type: "date_picker";
      salonId: string;
      serviceId: string | null;
      dates: DateOption[];
    }
  | {
      type: "service_picker";
      salonId: string;
      date: string | null;
      services: ServiceOption[];
    }
  | { type: "counter_picker"; counters: CounterOption[] }
  | {
      type: "slot_picker";
      date: string;
      counterName: string | null;
      groups: SlotGroup[];
      /** The band a typed "evening" / "bikele" asked for: the picker scrolls
       *  to it. Every band is still shown. */
      focus?: "Morning" | "Afternoon" | "Evening" | null;
      /** "after 5": times before this are dimmed, not hidden. */
      after?: string | null;
    }
  | {
      type: "booking_summary";
      salon: SummarySalon;
      service: SummaryService;
      counter: SummaryCounter;
      staff: { id: string; name: string } | null;
      slot: {
        id: string;
        date: string;
        startTime: string;
        endTime: string | null;
      };
      priceMinor: number;
      depositMinor: number;
      dueAtSalonMinor: number;
      /** ISO instant, or null when free cancellation has already lapsed. */
      freeCancellationUntil: string | null;
      cancellationWindowMin: number;
      wallet: {
        signedIn: boolean;
        availableMinor: number;
        shortfallMinor: number;
      };
      /** The existing review page, pre-filled. */
      handoffUrl: string;
      /** True once the slot is held for this customer and a Confirm token has
       *  been signed. Guests, and anyone whose hold was lost, get false and the
       *  handoff instead. */
      canConfirmInChat: boolean;
      /** Signed quote for `POST /assistant/bookings/confirm`. Goes to the UI
       *  block only — never into a model prompt or a tool result, which is what
       *  keeps Phase 6's model away from the money. */
      confirmToken?: string;
      /** ISO instant the hold lapses, for the countdown on the button. */
      holdExpiresAt?: string;
      /** Present when this summary moves an existing booking: the button
       *  reads "Move booking", and what cancelling the old one costs is on the
       *  card before the tap. */
      reschedule?: RescheduleInfo;
    }
  | {
      type: "booking_list";
      scope: "upcoming" | "past";
      bookings: BookingListItem[];
    }
  | {
      /**
       * What cancelling costs, shown before the customer is asked. Built from
       * `getCancellationPreview`, the same quote the cancel endpoint applies,
       * so the figure here and the figure charged cannot disagree.
       */
      type: "cancellation_preview";
      appointmentId: string;
      startsAt: string;
      freeCancellation: boolean;
      cancellationWindowMin: number;
      depositMinor: number;
      penaltyMinor: number;
      penaltyPercent: number;
      refundMinor: number;
      /** False once the appointment has started — then only the salon can. */
      cancellable: boolean;
      salonName: string;
      salonPhone: string;
      serviceName: string;
      date: string;
      startTime: string;
      actions: QuickReply[];
    }
  | {
      type: "booking_confirmed";
      appointmentId: string;
      /** The short code the counter asks for; null on the oldest rows. */
      token: string | null;
      /** Place in the queue for that salon + service + counter + day. */
      serialNumber: number | null;
      salonName: string;
      salonAddress: string;
      salonPhone: string;
      serviceName: string;
      date: string;
      startTime: string;
      endTime: string | null;
      counterName: string | null;
      staffName: string | null;
      totalMinor: number;
      depositMinor: number;
      dueAtSalonMinor: number;
      /** ISO instant, or null when the window has already closed. */
      freeCancellationUntil: string | null;
      /** Directions; null when the salon has no coordinates. */
      mapUrl: string | null;
      manageUrl: string;
    }
  | {
      /**
       * A doorway to the existing top-up, not a second one: the buttons post to
       * `POST /assistant/payments/topup`, which is `initiateTopup` plus a note
       * on the conversation. Never an action — money must not be something a
       * replayed tap can start.
       */
      type: "payment_prompt";
      /** Zero when no booking is in play (the "My wallet" chip). */
      shortfallMinor: number;
      /** The shortfall rounded up to a round figure, never under the minimum. */
      suggestedTopupMinor: number;
      minTopupMinor: number;
      /** Poisha, ascending, every one enough to cover the shortfall. */
      presets: number[];
      /** Display only — the gateway page is where one is chosen. */
      methods: string[];
      /** "Top up & book" is offered: a live, held summary is behind this. */
      canAutoConfirm: boolean;
    };

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

export type ServiceOption = {
  id: string;
  name: string;
  category: string;
  priceMinor: number;
  /** Minutes. */
  duration: number;
  /** What this salon would hold for this service, resolved not guessed. */
  depositMinor: number;
  slotCount: number;
};

export type CounterOption = {
  id: string;
  name: string;
  code: string | null;
  slotCount: number;
};

export type SummarySalon = {
  id: string;
  name: string;
  area: string;
  address: string;
  phone: string;
};

export type SummaryService = {
  id: string;
  name: string;
  category: string;
  priceMinor: number;
  duration: number;
};

export type SummaryCounter = { id: string; name: string; code: string | null };

export type RescheduleInfo = {
  appointmentId: string;
  /** "Thu 24 Sep 17:45" — the booking being moved, in the card's words. */
  label: string;
  date: string;
  startTime: string;
  /** What cancelling the old booking keeps, quoted now; 0 inside the free
   *  window. The move is a new booking plus this cancellation. */
  penaltyMinor: number;
  depositMinor: number;
  freeCancellation: boolean;
};

export type BookingListItem = {
  id: string;
  salonId: string;
  salonName: string;
  salonPhone: string;
  serviceName: string;
  date: string;
  startTime: string;
  endTime: string | null;
  status: string;
  token: string | null;
  serialNumber: number | null;
  counterName: string | null;
  totalMinor: number;
  depositMinor: number;
  dueAtSalonMinor: number;
  canCancel: boolean;
  canReschedule: boolean;
  actions: QuickReply[];
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

/** The rest take their whole shape from the caller: they are data the handler
 *  assembled from a salon, a wallet and a slot list, not fields to re-derive. */
type BlockOf<T extends Block["type"]> = Omit<Extract<Block, { type: T }>, "type">;

export const walletStatus = (fields: BlockOf<"wallet_status">): Block => ({
  type: "wallet_status",
  ...fields,
});

export const datePicker = (fields: BlockOf<"date_picker">): Block => ({
  type: "date_picker",
  ...fields,
});

export const servicePicker = (fields: BlockOf<"service_picker">): Block => ({
  type: "service_picker",
  ...fields,
});

export const counterPicker = (counters: CounterOption[]): Block => ({
  type: "counter_picker",
  counters,
});

export const slotPicker = (fields: BlockOf<"slot_picker">): Block => ({
  type: "slot_picker",
  ...fields,
});

export const bookingSummary = (fields: BlockOf<"booking_summary">): Block => ({
  type: "booking_summary",
  ...fields,
});

export const bookingConfirmed = (
  fields: BlockOf<"booking_confirmed">,
): Block => ({ type: "booking_confirmed", ...fields });

export const bookingList = (fields: BlockOf<"booking_list">): Block => ({
  type: "booking_list",
  ...fields,
});

export const cancellationPreview = (
  fields: BlockOf<"cancellation_preview">,
): Block => ({ type: "cancellation_preview", ...fields });

export const paymentPromptBlock = (
  fields: BlockOf<"payment_prompt">,
): Block => ({ type: "payment_prompt", ...fields });
