import { Prisma } from "@prisma/client";
import prisma from "../../shared/prisma";
import { hasSlotStarted } from "../../utils/slotTime";
import { SALON_TIME_ZONE } from "../AI-Suggestion/ai.constants";

/**
 * Availability is the filter at every step of the funnel: a date with no free
 * slot is never offered, a service with no free slot that day is never offered,
 * a counter with no free slot is never offered. That is what stops the chat
 * dead-ending on "sorry, that one is taken" three taps in.
 *
 * Everything below reads one query's worth of slots. The date, service, counter
 * and time steps are four views of the same list, not four round trips.
 */

export type OpenSlot = {
  id: string;
  date: Date;
  startTime: string;
  endTime: string | null;
  serviceId: string | null;
  counterId: string | null;
  counterName: string | null;
};

/* ------------------------------------------------------------------- dates */

/**
 * Today as the salon sees it. Never `new Date().toISOString()`: on a server
 * west of Dhaka that is still yesterday for six hours every evening, which
 * hides a whole day of slots from the customer.
 */
export const dhakaToday = (now = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: SALON_TIME_ZONE }).format(now);

/** "YYYY-MM-DD" -> the UTC midnight `slot.date` is normalised to. */
export const toCalendarDate = (ymd: string): Date => {
  const [year, month, day] = ymd.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};

/** The inverse. Safe because the Date is UTC midnight by construction. */
export const toYmd = (date: Date): string => date.toISOString().slice(0, 10);

export const shiftYmd = (ymd: string, days: number): string => {
  const shifted = toCalendarDate(ymd);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return toYmd(shifted);
};

/** Shape and calendar both: "2026-02-31" parses, but it is not a real day. */
export const isYmd = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && toYmd(toCalendarDate(value)) === value;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "Today", "Tomorrow", else "Wed 24 Sep". Read in UTC, because that is the
 *  calendar the date was written in. */
export const dateLabel = (ymd: string, today = dhakaToday()): string => {
  if (ymd === today) return "Today";
  if (ymd === shiftYmd(today, 1)) return "Tomorrow";

  const date = toCalendarDate(ymd);
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
};

/* ------------------------------------------------------------------ loader */

/**
 * Every free, not-yet-started slot for a salon in a window — the single source
 * the date, service, counter and slot steps all read from.
 *
 * `serviceId` and `counterId` are matched the way `bookAppointment` matches
 * them: a slot with a null service is bookable with any service of that salon,
 * and a slot with a null counter can be taken by any chair. Offering slots on
 * looser rules than the booking endpoint enforces is how a chat sells a time
 * the API then refuses.
 */
export const loadOpenSlots = async (args: {
  salonId: string;
  from: Date;
  to: Date;
  serviceId?: string;
  counterId?: string;
  now?: Date;
}): Promise<OpenSlot[]> => {
  // Two `OR` keys in one `where` overwrite each other, so the pair goes into an
  // `AND` array the moment both filters are present.
  const and: Prisma.SlotWhereInput[] = [];
  if (args.serviceId) {
    and.push({ OR: [{ serviceId: args.serviceId }, { serviceId: null }] });
  }
  if (args.counterId) {
    and.push({ OR: [{ counterId: args.counterId }, { counterId: null }] });
  }

  const rows = await prisma.slot.findMany({
    where: {
      salonId: args.salonId,
      status: "AVAILABLE",
      isBooked: false,
      date: { gte: args.from, lte: args.to },
      ...(and.length ? { AND: and } : {}),
    },
    select: {
      id: true,
      date: true,
      startTime: true,
      endTime: true,
      serviceId: true,
      counterId: true,
      counter: { select: { name: true, isActive: true, isDeleted: true } },
    },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
  });

  const now = args.now ?? new Date();

  return (
    rows
      // A retired chair's slots are not bookable; a slot with no chair still is.
      .filter(
        (row) => !row.counter || (row.counter.isActive && !row.counter.isDeleted),
      )
      // In memory, because a WHERE clause cannot compare an "HH:mm" string to a
      // timestamp — the same reason `getSlots` filters `upcomingOnly` here too.
      .filter((row) => !hasSlotStarted(row, now))
      .map((row) => ({
        id: row.id,
        date: row.date,
        startTime: row.startTime,
        endTime: row.endTime,
        serviceId: row.serviceId,
        counterId: row.counterId,
        counterName: row.counter?.name ?? null,
      }))
  );
};

/* -------------------------------------------------------- views over slots */

export type DateOption = { date: string; label: string; slotCount: number };

/** The days that still have something free, in order. */
export const groupDates = (
  slots: OpenSlot[],
  today = dhakaToday(),
): DateOption[] => {
  const counts = new Map<string, number>();

  for (const slot of slots) {
    const key = toYmd(slot.date);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, slotCount]) => ({
      date,
      label: dateLabel(date, today),
      slotCount,
    }));
};

/** Services with at least one matching slot. A slot with a null service counts
 *  for every service, which is how salons generating generic slots work. */
export const serviceOptions = <T extends { id: string }>(
  slots: OpenSlot[],
  services: T[],
): { service: T; slotCount: number }[] =>
  services
    .map((service) => ({
      service,
      slotCount: slots.filter(
        (slot) => slot.serviceId === service.id || slot.serviceId === null,
      ).length,
    }))
    .filter((option) => option.slotCount > 0);

/**
 * Which counters can actually take this service on this date — the same rule
 * the website's booking modal applies, so the chat and the page never disagree
 * about which chairs are free.
 *
 * One entry per start time: where a counter's own slot and a shared unassigned
 * one cover the same minute, the counter's own wins.
 */
export const counterOptions = <T extends { id: string }>(
  slots: OpenSlot[],
  counters: T[],
): { counter: T; slots: OpenSlot[] }[] =>
  counters
    .map((counter) => {
      const byTime = new Map<string, OpenSlot>();

      for (const slot of slots) {
        if (slot.counterId !== null && slot.counterId !== counter.id) continue;

        const existing = byTime.get(slot.startTime);
        if (
          !existing ||
          (existing.counterId === null && slot.counterId === counter.id)
        ) {
          byTime.set(slot.startTime, slot);
        }
      }

      return {
        counter,
        slots: [...byTime.values()].sort((a, b) =>
          a.startTime.localeCompare(b.startTime),
        ),
      };
    })
    .filter((option) => option.slots.length > 0);

export type SlotChoice = {
  id: string;
  startTime: string;
  endTime: string | null;
  counterId: string | null;
  counterName: string | null;
};

export type SlotGroup = { label: string; slots: SlotChoice[] };

const BANDS = [
  { label: "Morning", until: 12 },
  { label: "Afternoon", until: 17 },
  { label: "Evening", until: 24 },
];

const bandOf = (startTime: string): string => {
  const hour = Number(startTime.slice(0, 2)) || 0;
  return (BANDS.find((band) => hour < band.until) ?? BANDS[2]).label;
};

/** Morning before noon, Afternoon to 16:59, Evening from 17:00. Thirty times in
 *  one list is a wall; three short rows is a choice. */
export const slotGroups = (slots: OpenSlot[]): SlotGroup[] =>
  BANDS.map(({ label }) => ({
    label,
    slots: slots
      .filter((slot) => bandOf(slot.startTime) === label)
      .sort((a, b) => a.startTime.localeCompare(b.startTime))
      .map(
        (slot): SlotChoice => ({
          id: slot.id,
          startTime: slot.startTime,
          endTime: slot.endTime,
          counterId: slot.counterId,
          counterName: slot.counterName,
        }),
      ),
  })).filter((group) => group.slots.length > 0);
