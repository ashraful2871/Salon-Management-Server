/**
 * Turning a calendar day plus an "HH:mm" string into an instant.
 *
 * Slots store a date and a wall-clock time separately, so every part of the
 * system that needs to know whether a slot has passed - the cancellation
 * window, the auto no-show sweep, the booking guard, the slot list - has to
 * agree on how those two halves combine. This is the one place that decides.
 *
 * The time is read as server-local, matching how slots are generated. If this
 * API ever serves salons in more than one timezone, this is the function that
 * has to learn about them, and fixing it here fixes it everywhere.
 */
export const atWallClock = (day: Date, hhmm: string | null | undefined): Date => {
  if (!hhmm) return new Date(day);

  const [hours, minutes] = hhmm.split(":").map(Number);

  // The calendar day is read in UTC because that is how it was written -
  // `toCalendarDate` in the slot service normalises every date to UTC midnight.
  // Reading it locally instead would land on the day before on any server west
  // of Greenwich, which is a whole day's worth of wrong for the cancellation
  // window and the no-show sweep. The time of day stays server-local, matching
  // how slots are generated.
  return new Date(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    hours || 0,
    minutes || 0,
    0,
    0,
  );
};

/** When this slot begins. */
export const slotStartsAt = (slot: { date: Date; startTime: string }): Date =>
  atWallClock(slot.date, slot.startTime);

/**
 * True once the slot's start time has arrived. A slot that has started cannot
 * be booked - there is no point selling a seat for a train that has left.
 */
export const hasSlotStarted = (
  slot: { date: Date; startTime: string },
  now = new Date(),
): boolean => slotStartsAt(slot).getTime() <= now.getTime();
