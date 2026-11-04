import ApiError from "../../Error/error";
import { formatBDT } from "../../utils/money";
import { priceCart } from "../HomeService/home.money";
import * as HomePublic from "../HomeService/home.public";
import type { AssistantAction, TurnContext, TurnResult } from "./assistant.actions";
import { loadSalon, salonGone } from "./assistant.actions";
import { notice, quickReplies, type Block, type QuickReply } from "./assistant.blocks";
import { advance, type AssistantState } from "./assistant.state";

/**
 * Booking a home visit from the chat, at the salon the customer is looking at.
 *
 *   home_book (who is it for?) → home_services → home_date → home_time
 *
 * Every step re-reads the branch's live menu and availability through the Home
 * Service module's own public reads, so the chat can never offer a service,
 * day or time the booking page would refuse. The last card is priced exactly
 * as the quote will be (`priceCart`, `homeService.advancePercent`) and hands
 * off to /home-service/book at the address step: the address, the disclaimer
 * and paying the advance stay on the one page that already does them.
 */

type Audience = "LADIES" | "GENTS";
type Menu = Awaited<ReturnType<typeof HomePublic.getSalonMenu>>;

/** Day chips shown at once; the booking window is longer than a chat row. */
const MAX_DAYS = 10;
/** Time chips shown at once. */
const MAX_TIMES = 24;

const SIDE_TITLE: Record<Audience, string> = { LADIES: "Ladies at home", GENTS: "Gents at home" };

const viewerOf = (ctx: TurnContext) => (ctx.userId ? { userId: ctx.userId } : undefined);

const reason = (error: unknown) =>
  error instanceof ApiError ? error.message : "Home service isn't available here right now.";

/** Back to the salon card, or somewhere else entirely. */
const exits = (extra: QuickReply[] = []): Block =>
  quickReplies([
    ...extra,
    { label: "Book at the salon", action: { type: "book" }, icon: "calendar" },
    { label: "Another salon", action: { type: "find_nearby" }, icon: "map-pin" },
  ]);

const stop = (state: AssistantState, text: string, extra: QuickReply[] = []): TurnResult => ({
  text,
  blocks: [notice("warn", text), exits(extra)],
  state,
});

/** The customer's saved point, so the menu can say whether this branch reaches them. */
const pointOf = (state: AssistantState) =>
  state.location ? { lat: String(state.location.lat), lng: String(state.location.lng) } : {};

const loadMenu = (ctx: TurnContext, state: AssistantState, salonId: string, audience: Audience) =>
  HomePublic.getSalonMenu(viewerOf(ctx), salonId, { audience, ...pointOf(state) });

/** One expert who does the whole cart, best rated first, preferring one free at `freeIds`. */
const anchorFor = (menu: Menu, offeringIds: string[], freeIds?: string[]) => {
  const covering = menu.experts.filter((e) => offeringIds.every((id) => e.offeringIds.includes(id)));
  return (freeIds && covering.find((e) => freeIds.includes(e.id))) ?? covering[0] ?? null;
};

const priceOf = (menu: Menu, offeringIds: string[]) => {
  const items = menu.menu.filter((m) => offeringIds.includes(m.id));
  // The menu's travel fee is already clamped to the platform cap.
  const price = priceCart(items, { travelFeeMinor: menu.salon.travelFeeMinor }, {
    advancePercent: menu.advancePercent,
    commissionPercent: 0,
    travelFeeMaxMinor: Number.MAX_SAFE_INTEGER,
  });
  return { items, price };
};

const pickerBlock = (menu: Menu, selected: string[]): Block => ({
  type: "home_service_picker",
  salonId: menu.salon.id,
  salonName: menu.salon.name,
  audience: menu.audience,
  advancePercent: menu.advancePercent,
  travelFeeMinor: menu.salon.travelFeeMinor,
  minOrderMinor: menu.salon.minOrderMinor,
  selected,
  services: menu.menu.map((m) => ({
    id: m.id,
    name: m.name,
    category: m.category,
    priceMinor: m.priceMinor,
    durationMin: m.durationMin,
    kitNote: m.kitNote,
  })),
});

/** The menu again, with what is ticked and why we are back here. */
const backToMenu = (state: AssistantState, menu: Menu, selected: string[], why: string): TurnResult => ({
  text: why,
  blocks: [notice("warn", why), pickerBlock(menu, selected), exits()],
  state: advance(state, { step: "home", home: { audience: menu.audience } }),
});

/* ------------------------------------------------------------- home_book */

export const handleHomeBook = async (
  state: AssistantState,
  ctx: TurnContext,
  action: Extract<AssistantAction, { type: "home_book" }>,
): Promise<TurnResult> => {
  if (!state.salonId) {
    return stop(state, "Pick a salon first, then I can book its home service.");
  }
  const salon = await loadSalon(state.salonId);
  if (!salon) return salonGone(state);

  const sides = await HomePublic.homeSidesOf(salon);
  if (!sides.ladies && !sides.gents) {
    return stop(advance(state, { step: "salon" }), `${salon.name} isn't taking home bookings right now.`);
  }

  // Who it is for: asked only when the branch serves both sides.
  const only: Audience | undefined = sides.ladies && !sides.gents ? "LADIES" : !sides.ladies ? "GENTS" : undefined;
  const audience = action.audience ?? state.home?.audience ?? only;
  if (!audience) {
    const text = `${salon.name} comes to homes for ladies and gents. Who is it for?`;
    return {
      text,
      blocks: [
        quickReplies([
          { label: SIDE_TITLE.LADIES, action: { type: "home_book", audience: "LADIES" }, style: "primary" },
          { label: SIDE_TITLE.GENTS, action: { type: "home_book", audience: "GENTS" }, style: "primary" },
        ]),
        exits(),
      ],
      state: advance(state, { step: "home", home: undefined }),
    };
  }
  if (!(audience === "LADIES" ? sides.ladies : sides.gents)) {
    const other: Audience = audience === "LADIES" ? "GENTS" : "LADIES";
    return stop(state, `${salon.name} isn't taking ${SIDE_TITLE[audience].toLowerCase()} bookings right now.`, [
      { label: SIDE_TITLE[other], action: { type: "home_book", audience: other }, style: "primary" },
    ]);
  }

  let menu: Menu;
  try {
    menu = await loadMenu(ctx, state, salon.id, audience);
  } catch (error) {
    return stop(advance(state, { step: "salon" }), reason(error));
  }

  // Keep what an earlier pass ticked, if this side still offers it.
  const live = new Set(menu.menu.map((m) => m.id));
  const selected = (state.home?.audience === audience ? (state.home.offeringIds ?? []) : []).filter((id) =>
    live.has(id),
  );

  const blocks: Block[] = [];
  if (menu.servesYou === false && state.location) {
    blocks.push(
      notice(
        "info",
        `${state.location.label} looks outside ${salon.name}'s home area. You can still book for an address it reaches.`,
      ),
    );
  }
  blocks.push(pickerBlock(menu, selected), exits());

  const travel = menu.salon.travelFeeMinor > 0 ? ` plus a ${formatBDT(menu.salon.travelFeeMinor)} travel fee` : "";
  return {
    text: `${SIDE_TITLE[audience]} from ${salon.name}. Pick the services${travel}. You pay ${menu.advancePercent}% as an advance to confirm, and the rest at home.`,
    blocks,
    state: advance(state, {
      step: "home",
      home: { audience, ...(selected.length ? { offeringIds: selected } : {}) },
    }),
  };
};

/* --------------------------------------------------------- home_services */

export const handleHomeServices = async (
  state: AssistantState,
  ctx: TurnContext,
  action: Extract<AssistantAction, { type: "home_services" }>,
): Promise<TurnResult> => {
  const audience = state.home?.audience;
  if (!state.salonId || !audience) return handleHomeBook(state, ctx, { type: "home_book" });

  let menu: Menu;
  try {
    menu = await loadMenu(ctx, state, state.salonId, audience);
  } catch (error) {
    return stop(advance(state, { step: "salon" }), reason(error));
  }

  const live = new Set(menu.menu.map((m) => m.id));
  const offeringIds = [...new Set(action.offeringIds)].filter((id) => live.has(id)).slice(0, 10);
  if (!offeringIds.length) {
    return backToMenu(state, menu, [], "Those services aren't offered at home any more. Pick again.");
  }

  const { price } = priceOf(menu, offeringIds);
  const short = menu.salon.minOrderMinor - price.subtotalMinor;
  if (short > 0) {
    return backToMenu(
      state,
      menu,
      offeringIds,
      `Add ${formatBDT(short)} more: the minimum home order is ${formatBDT(menu.salon.minOrderMinor)}.`,
    );
  }
  if (!anchorFor(menu, offeringIds)) {
    return backToMenu(
      state,
      menu,
      offeringIds,
      "No one expert here does all of these in one visit. Remove a service and try again.",
    );
  }

  let days: Awaited<ReturnType<typeof HomePublic.getAvailabilityDays>>;
  try {
    days = await HomePublic.getAvailabilityDays(viewerOf(ctx), { salonId: state.salonId, offeringIds: offeringIds.join(",") });
  } catch (error) {
    return backToMenu(state, menu, offeringIds, reason(error));
  }

  const open = days.days.filter((d) => d.hasSlots).slice(0, MAX_DAYS);
  const next = advance(state, { step: "home", home: { audience, offeringIds } });
  if (!open.length) {
    return backToMenu(
      next,
      menu,
      offeringIds,
      "No expert is free for these services in the coming days. Try fewer services, or book at the salon.",
    );
  }

  return {
    text: `${offeringIds.length} service${offeringIds.length === 1 ? "" : "s"}, ${formatBDT(price.totalMinor)} in all, ${formatBDT(price.advanceMinor)} advance. Which day?`,
    blocks: [
      quickReplies(open.map((d) => ({ label: d.label, action: { type: "home_date", date: d.date }, icon: "calendar" }))),
      quickReplies([
        { label: "Change services", action: { type: "home_book", audience }, icon: "scissors", style: "ghost" },
      ]),
    ],
    state: next,
  };
};

/* ------------------------------------------------------------- home_date */

export const handleHomeDate = async (
  state: AssistantState,
  ctx: TurnContext,
  action: Extract<AssistantAction, { type: "home_date" }>,
): Promise<TurnResult> => {
  const home = state.home;
  if (!state.salonId || !home?.offeringIds?.length) return handleHomeBook(state, ctx, { type: "home_book" });

  let slots: Awaited<ReturnType<typeof HomePublic.getAvailability>>["slots"];
  try {
    ({ slots } = await HomePublic.getAvailability(viewerOf(ctx), {
      salonId: state.salonId,
      offeringIds: home.offeringIds.join(","),
      date: action.date,
    }));
  } catch (error) {
    return stop(state, reason(error), [
      { label: "Change services", action: { type: "home_book", audience: home.audience }, icon: "scissors" },
    ]);
  }

  if (!slots.length) {
    const again = await handleHomeServices(state, ctx, { type: "home_services", offeringIds: home.offeringIds });
    const why = "That day just filled up. Here are the days that are still free.";
    return { ...again, text: why, blocks: [notice("warn", why), ...again.blocks] };
  }

  const shown = slots.slice(0, MAX_TIMES);
  return {
    text: "What time should the expert arrive?",
    blocks: [
      quickReplies(
        shown.map((s) => ({
          label: s.label,
          action: { type: "home_time", startAt: new Date(s.startAt).toISOString() },
          icon: "clock",
        })),
      ),
      quickReplies([
        { label: "Change day", action: { type: "home_services", offeringIds: home.offeringIds }, icon: "calendar", style: "ghost" },
        { label: "Change services", action: { type: "home_book", audience: home.audience }, icon: "scissors", style: "ghost" },
      ]),
    ],
    state: advance(state, { step: "home", home: { audience: home.audience, offeringIds: home.offeringIds, date: action.date } }),
  };
};

/* ------------------------------------------------------------- home_time */

export const handleHomeTime = async (
  state: AssistantState,
  ctx: TurnContext,
  action: Extract<AssistantAction, { type: "home_time" }>,
): Promise<TurnResult> => {
  const home = state.home;
  if (!state.salonId || !home?.offeringIds?.length || !home.date) {
    return handleHomeBook(state, ctx, { type: "home_book" });
  }

  let menu: Menu;
  let slots: Awaited<ReturnType<typeof HomePublic.getAvailability>>["slots"];
  try {
    menu = await loadMenu(ctx, state, state.salonId, home.audience);
    ({ slots } = await HomePublic.getAvailability(viewerOf(ctx), {
      salonId: state.salonId,
      offeringIds: home.offeringIds.join(","),
      date: home.date,
    }));
  } catch (error) {
    return stop(state, reason(error));
  }

  // The time must still be free: re-checked now, not trusted from the chip.
  const wanted = Date.parse(action.startAt);
  const slot = slots.find((s) => new Date(s.startAt).getTime() === wanted);
  if (!slot) {
    const again = await handleHomeDate(state, ctx, { type: "home_date", date: home.date });
    const why = "Someone just took that time. Pick another.";
    return { ...again, text: why, blocks: [notice("warn", why), ...again.blocks] };
  }

  const { items, price } = priceOf(menu, home.offeringIds);
  if (items.length !== home.offeringIds.length) {
    return backToMenu(state, menu, items.map((i) => i.id), "A service changed since you picked it. Check the list again.");
  }
  const anchor = anchorFor(menu, home.offeringIds, slot.expertIds);
  if (!anchor) {
    return backToMenu(state, menu, home.offeringIds, "No one expert here does all of these in one visit any more.");
  }

  const startAt = new Date(slot.startAt).toISOString();
  const query = new URLSearchParams({
    expert: anchor.id,
    any: "1",
    items: home.offeringIds.join(","),
    date: home.date,
    time: startAt,
    step: "address",
  });
  const handoffUrl = `/home-service/book?${query.toString()}`;
  const day = (await HomePublic.getAvailabilityDays(viewerOf(ctx), {
    salonId: state.salonId,
    offeringIds: home.offeringIds.join(","),
  }).catch(() => null))?.days.find((d) => d.date === home.date);

  const summary: Block = {
    type: "home_summary",
    salon: { id: menu.salon.id, name: menu.salon.name, area: menu.salon.area },
    audience: home.audience,
    services: items.map((i) => ({ id: i.id, name: i.name, priceMinor: i.priceMinor, durationMin: i.durationMin })),
    date: home.date,
    dateLabel: day?.label ?? home.date,
    startAt,
    timeLabel: slot.label,
    subtotalMinor: price.subtotalMinor,
    travelFeeMinor: price.travelFeeMinor,
    totalMinor: price.totalMinor,
    advancePercent: price.advancePercent,
    advanceMinor: price.advanceMinor,
    balanceMinor: price.balanceMinor,
    handoffUrl,
    signedIn: Boolean(ctx.userId),
  };

  return {
    text: `${slot.label}, ${day?.label ?? home.date}. Pay the ${formatBDT(price.advanceMinor)} advance to confirm; ${formatBDT(price.balanceMinor)} is paid at home after the service. Add your address next.`,
    blocks: [
      summary,
      quickReplies([
        { label: "Change time", action: { type: "home_date", date: home.date }, icon: "clock", style: "ghost" },
        { label: "Change day", action: { type: "home_services", offeringIds: home.offeringIds }, icon: "calendar", style: "ghost" },
        { label: "Change services", action: { type: "home_book", audience: home.audience }, icon: "scissors", style: "ghost" },
      ]),
    ],
    state: advance(state, { step: "home", home: { ...home, startAt } }),
  };
};

/** "Where we are" for a home draft, drawn again (a stale tap, a reopened panel). */
export const renderHome = (state: AssistantState, ctx: TurnContext): Promise<TurnResult> => {
  const home = state.home;
  if (home?.date && home.offeringIds?.length) return handleHomeDate(state, ctx, { type: "home_date", date: home.date });
  if (home?.offeringIds?.length) return handleHomeServices(state, ctx, { type: "home_services", offeringIds: home.offeringIds });
  return handleHomeBook(state, ctx, { type: "home_book", ...(home?.audience ? { audience: home.audience } : {}) });
};

/** Whether the salon card should offer "Book at home". Never throws. */
export const homeBookable = async (salon: Parameters<typeof HomePublic.homeSidesOf>[0]) => {
  try {
    const sides = await HomePublic.homeSidesOf(salon);
    return sides.ladies || sides.gents;
  } catch {
    return false;
  }
};

export const AssistantHome = {
  handleHomeBook,
  handleHomeServices,
  handleHomeDate,
  handleHomeTime,
  renderHome,
  homeBookable,
};
