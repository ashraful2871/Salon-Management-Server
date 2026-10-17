import { BookingPause } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { audit, AuditCtx, systemAuditCtx } from "../../utils/audit";
import { AccessUser, assertOwnerOf } from "../../utils/salonAccess";
import { duesPauseDue } from "../Settlement/settlement.dues";

/**
 * The owner's own pause on online bookings (walk-ins and existing bookings
 * carry on). A DUES pause belongs to the platform: the owner can neither
 * replace it nor lift it, only pay (Money).
 */

const MAX_PAUSE_DAYS = 90;

const PAUSE_SELECT = {
  id: true,
  ownerId: true,
  bookingPause: true,
  bookingPauseReason: true,
  bookingPauseUntil: true,
  bookingPausedAt: true,
} as const;

const loadOwned = async (user: AccessUser, salonId: string) => {
  const { salonIds } = await assertOwnerOf(user);
  if (!salonIds.includes(salonId)) throw new ApiError(StatusCodes.NOT_FOUND, "Not found");
  const salon = await prisma.salon.findUnique({ where: { id: salonId }, select: PAUSE_SELECT });
  if (!salon) throw new ApiError(StatusCodes.NOT_FOUND, "Not found");
  return salon;
};

const duesConflict = () =>
  ApiError.withCode(StatusCodes.CONFLICT, "Clear dues first", "DUES_PAUSED");

const getPause = async (user: AccessUser, salonId: string) => {
  const { ownerId: _ownerId, id: _id, ...pause } = await loadOwned(user, salonId);
  return pause;
};

const pauseSalon = async (
  user: AccessUser,
  ctx: AuditCtx,
  salonId: string,
  body: { reason: string; until?: string },
) => {
  const salon = await loadOwned(user, salonId);
  if (salon.bookingPause === BookingPause.DUES) throw duesConflict();

  const until = body.until ? new Date(body.until) : null;
  if (until) {
    const now = Date.now();
    if (until.getTime() <= now) throw new ApiError(StatusCodes.BAD_REQUEST, "Pick an end time in the future.");
    if (until.getTime() - now > MAX_PAUSE_DAYS * 24 * 60 * 60 * 1000) {
      throw new ApiError(StatusCodes.BAD_REQUEST, `A pause can last at most ${MAX_PAUSE_DAYS} days.`);
    }
  }

  // The conditional update keeps a dues pause that landed a moment ago.
  const { count } = await prisma.salon.updateMany({
    where: { id: salonId, bookingPause: { not: BookingPause.DUES } },
    data: {
      bookingPause: BookingPause.OWNER,
      bookingPauseReason: body.reason.trim(),
      bookingPauseUntil: until,
      bookingPausedAt: salon.bookingPause === BookingPause.OWNER ? salon.bookingPausedAt : new Date(),
    },
  });
  if (count === 0) throw duesConflict();

  const after = await getPause(user, salonId);
  await audit(ctx, {
    action: "salon.pause",
    entityType: "salon",
    entityId: salonId,
    salonId,
    before: { bookingPause: salon.bookingPause, bookingPauseUntil: salon.bookingPauseUntil },
    after,
    reason: body.reason,
  });
  return after;
};

const resumeSalon = async (user: AccessUser, ctx: AuditCtx, salonId: string) => {
  const salon = await loadOwned(user, salonId);
  if (salon.bookingPause === BookingPause.DUES) throw duesConflict();
  if (salon.bookingPause === BookingPause.NONE) return getPause(user, salonId);

  // dues.watch leaves an OWNER pause alone, so a business past its dues
  // deadline must not walk out of it into taking bookings: the branch takes
  // the DUES pause it would have had.
  if (await duesPauseDue(salon.ownerId)) {
    await prisma.salon.update({
      where: { id: salonId },
      data: {
        bookingPause: BookingPause.DUES,
        bookingPauseReason: "Unpaid dues",
        bookingPausedAt: new Date(),
        bookingPauseUntil: null,
      },
    });
    await audit(ctx, {
      action: "salon.pause",
      entityType: "salon",
      entityId: salonId,
      salonId,
      before: { bookingPause: salon.bookingPause },
      after: { bookingPause: BookingPause.DUES },
      reason: "Resume refused: unpaid dues",
    });
    throw duesConflict();
  }

  await prisma.salon.updateMany({
    where: { id: salonId, bookingPause: BookingPause.OWNER },
    data: { bookingPause: BookingPause.NONE, bookingPauseReason: null, bookingPauseUntil: null, bookingPausedAt: null },
  });
  await audit(ctx, {
    action: "salon.resume",
    entityType: "salon",
    entityId: salonId,
    salonId,
    before: { bookingPause: salon.bookingPause, reason: salon.bookingPauseReason },
  });
  return getPause(user, salonId);
};

/**
 * Lifts OWNER pauses whose `until` has passed. Run hourly from `dues.watch`
 * (before its once-a-day gate), so an end time is honoured within the hour.
 */
export const clearExpiredOwnerPauses = async (now = new Date()) => {
  const expired = await prisma.salon.findMany({
    where: { bookingPause: BookingPause.OWNER, bookingPauseUntil: { lte: now } },
    select: { id: true, ownerId: true },
  });
  if (!expired.length) return 0;

  const ctx = systemAuditCtx("job");
  let cleared = 0;
  for (const salon of expired) {
    // A business past its dues deadline moves to DUES instead of reopening.
    const dues = await duesPauseDue(salon.ownerId);
    const { count } = await prisma.salon.updateMany({
      where: { id: salon.id, bookingPause: BookingPause.OWNER, bookingPauseUntil: { lte: now } },
      data: dues
        ? { bookingPause: BookingPause.DUES, bookingPauseReason: "Unpaid dues", bookingPausedAt: now, bookingPauseUntil: null }
        : { bookingPause: BookingPause.NONE, bookingPauseReason: null, bookingPauseUntil: null, bookingPausedAt: null },
    });
    if (count) {
      cleared += 1;
      await audit(ctx, {
        action: dues ? "salon.pause" : "salon.resume",
        entityType: "salon",
        entityId: salon.id,
        salonId: salon.id,
        after: { bookingPause: dues ? BookingPause.DUES : BookingPause.NONE },
        reason: "Owner pause ended",
      });
    }
  }
  return cleared;
};

export const SalonPauseService = { getPause, pauseSalon, resumeSalon };
