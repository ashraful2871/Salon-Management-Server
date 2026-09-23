import prisma from "../../shared/prisma";
import { HOLD_MINUTES, MAX_ACTIVE_HOLDS } from "./assistant.constants";

/**
 * Holds, not locks.
 *
 * A prepared booking keeps its slot for `HOLD_MINUTES` so a customer reading
 * the summary does not lose the chair to somebody who started later. Nothing
 * depends on the hold ever being cleaned up: expiry is part of the claim
 * predicate in `claimSlotAndCreate`, so a lapsed hold is bookable again the
 * moment it lapses, by anyone, with no job involved.
 */

const holdsUntil = (minutes: number, now: Date) =>
  new Date(now.getTime() + minutes * 60_000);

/**
 * Take (or extend) this user's hold on a slot. False means somebody else holds
 * it or it is already gone — the caller shows alternatives rather than a price.
 *
 * The predicate is the whole mechanism: one `updateMany`, so two customers
 * tapping the same time at the same instant cannot both come back true.
 */
export const holdSlot = async (
  slotId: string,
  userId: string,
  minutes: number = HOLD_MINUTES,
): Promise<boolean> => {
  const now = new Date();

  await releaseOldestOverLimit(userId, slotId, now);

  const { count } = await prisma.slot.updateMany({
    where: {
      id: slotId,
      status: "AVAILABLE",
      isBooked: false,
      OR: [
        { heldUntil: null },
        { heldUntil: { lt: now } },
        // Re-tapping your own held slot extends it rather than failing.
        { heldByUserId: userId },
      ],
    },
    data: { heldUntil: holdsUntil(minutes, now), heldByUserId: userId },
  });

  return count === 1;
};

/**
 * Best effort, and deliberately narrow: only a hold this user still owns is
 * dropped. Releasing someone else's would hand their chair away mid-checkout.
 */
export const releaseSlot = async (
  slotId: string,
  userId: string,
): Promise<void> => {
  try {
    await prisma.slot.updateMany({
      where: { id: slotId, heldByUserId: userId },
      data: { heldUntil: null, heldByUserId: null },
    });
  } catch {
    // A hold nobody can clear expires by itself. Never fail a turn over it.
  }
};

/**
 * Two active holds is the limit. A customer who reaches for a third is
 * comparing times, not hoarding them, so the oldest hold is released for them
 * instead of the new one being refused — refusing would leave them stuck
 * behind a chair they had already stopped wanting.
 */
const releaseOldestOverLimit = async (
  userId: string,
  keepSlotId: string,
  now: Date,
) => {
  const active = await prisma.slot.findMany({
    where: {
      heldByUserId: userId,
      heldUntil: { gt: now },
      id: { not: keepSlotId },
    },
    select: { id: true, heldUntil: true },
    orderBy: { heldUntil: "asc" },
  });

  // `keepSlotId` is excluded above, so re-holding a slot already held costs
  // nothing: at the limit there are MAX_ACTIVE_HOLDS - 1 others to keep.
  const excess = active.length - (MAX_ACTIVE_HOLDS - 1);
  if (excess <= 0) return;

  await prisma.slot.updateMany({
    where: { id: { in: active.slice(0, excess).map((slot) => slot.id) } },
    data: { heldUntil: null, heldByUserId: null },
  });
};

/** Whether this user's hold on a slot is still good, for the countdown. */
export const heldUntilFor = async (
  slotId: string,
  userId: string,
): Promise<Date | null> => {
  const slot = await prisma.slot.findFirst({
    where: { id: slotId, heldByUserId: userId, heldUntil: { gt: new Date() } },
    select: { heldUntil: true },
  });

  return slot?.heldUntil ?? null;
};

export const AssistantBooking = { holdSlot, releaseSlot, heldUntilFor };
