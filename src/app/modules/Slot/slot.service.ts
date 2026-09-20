import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { UserRole, SlotStatus } from "@prisma/client";
import { hasSlotStarted } from "../../utils/slotTime";

const MAX_RANGE_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Slots carry a calendar day, not an instant — normalize every date to UTC
// midnight so generating and later filtering by `date` match exactly.
const toCalendarDate = (value: string, label: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);

  if (match) {
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  }

  const parsed = new Date(value);

  if (isNaN(parsed.getTime())) {
    throw new ApiError(StatusCodes.BAD_REQUEST, `Invalid ${label} format`);
  }

  return new Date(
    Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate())
  );
};

const toMinutes = (time: string, label: string) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  const hours = match ? Number(match[1]) : NaN;
  const minutes = match ? Number(match[2]) : NaN;

  if (isNaN(hours) || isNaN(minutes) || hours > 23 || minutes > 59) {
    throw new ApiError(StatusCodes.BAD_REQUEST, `Invalid ${label}, expected HH:MM`);
  }

  return hours * 60 + minutes;
};

const formatMinutes = (value: number) =>
  `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;

const bulkCreateSlots = async (userId: string, userRole: string, payload: any) => {
  if (userRole !== UserRole.SALON_OWNER) {
    throw new ApiError(StatusCodes.FORBIDDEN, "Only salon owners can create slots");
  }

  const salonOwner = await prisma.salonOwner.findUnique({
    where: { userId },
  });

  if (!salonOwner) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Salon owner profile not found");
  }

  const salon = await prisma.salon.findUnique({
    where: { id: payload.salonId },
  });

  if (!salon || salon.ownerId !== salonOwner.id) {
    throw new ApiError(StatusCodes.FORBIDDEN, "You do not own this salon");
  }

  const {
    date,
    startDate,
    endDate,
    startTime,
    endTime,
    duration,
    breakDuration,
    serviceId,
    counterId,
  } = payload;

  const service = await prisma.service.findFirst({
    where: { id: serviceId, salonId: payload.salonId },
  });

  if (!service) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "Service not found or does not belong to this salon"
    );
  }

  if (counterId) {
    const counter = await prisma.counter.findFirst({
      where: { id: counterId, salonId: payload.salonId, isDeleted: false, isActive: true },
    });

    if (!counter) {
      throw new ApiError(
        StatusCodes.BAD_REQUEST,
        "Counter not found or does not belong to this salon"
      );
    }
  }

  // `date` is the legacy single-day payload; a range collapses to one day when
  // startDate and endDate are equal.
  const rangeStart = toCalendarDate(startDate || date, "start date");
  const rangeEnd = toCalendarDate(endDate || date, "end date");

  if (rangeEnd < rangeStart) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "End date must be on or after start date");
  }

  const totalDays = Math.round((rangeEnd.getTime() - rangeStart.getTime()) / MS_PER_DAY) + 1;

  if (totalDays > MAX_RANGE_DAYS) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `Date range cannot exceed ${MAX_RANGE_DAYS} days`
    );
  }

  const startMinutes = toMinutes(startTime, "start time");
  const endMinutes = toMinutes(endTime, "end time");

  if (endMinutes <= startMinutes) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "End time must be after start time");
  }

  // The daily template is identical for every day in the range.
  const template: { startTime: string; endTime: string; start: number; end: number }[] = [];
  for (
    let cursor = startMinutes;
    cursor + duration <= endMinutes;
    cursor += duration + (breakDuration || 0)
  ) {
    template.push({
      startTime: formatMinutes(cursor),
      endTime: formatMinutes(cursor + duration),
      start: cursor,
      end: cursor + duration,
    });
  }

  if (template.length === 0) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "Could not generate any slots with the provided settings"
    );
  }

  const days: Date[] = [];
  for (let i = 0; i < totalDays; i++) {
    days.push(new Date(rangeStart.getTime() + i * MS_PER_DAY));
  }

  // Slots on different counters may legitimately share a time, so conflicts are
  // scoped to the same counter (or to the unassigned pool when none is given).
  const existingSlots = await prisma.slot.findMany({
    where: {
      salonId: payload.salonId,
      serviceId,
      counterId: counterId || null,
      date: { gte: rangeStart, lte: rangeEnd },
    },
    select: { date: true, startTime: true, endTime: true },
  });

  const existingByDay = new Map<number, { start: number; end: number }[]>();
  for (const slot of existingSlots) {
    const key = slot.date.getTime();
    const bucket = existingByDay.get(key) || [];
    bucket.push({
      start: toMinutes(slot.startTime, "start time"),
      end: toMinutes(slot.endTime, "end time"),
    });
    existingByDay.set(key, bucket);
  }

  const slotsToCreate: {
    salonId: string;
    serviceId: string;
    counterId: string | null;
    date: Date;
    startTime: string;
    endTime: string;
    status: SlotStatus;
  }[] = [];
  const skippedDates = new Set<string>();
  let skipped = 0;

  for (const day of days) {
    const taken = existingByDay.get(day.getTime()) || [];

    for (const slot of template) {
      const overlaps = taken.some(
        (existing) => slot.start < existing.end && existing.start < slot.end
      );

      // A day that is already partly filled is skipped slot by slot rather than
      // failing the whole range — otherwise one busy day blocks the other 29.
      if (overlaps) {
        skipped++;
        skippedDates.add(day.toISOString().slice(0, 10));
        continue;
      }

      taken.push({ start: slot.start, end: slot.end });
      slotsToCreate.push({
        salonId: payload.salonId,
        serviceId,
        counterId: counterId || null,
        date: day,
        startTime: slot.startTime,
        endTime: slot.endTime,
        status: SlotStatus.AVAILABLE,
      });
    }

    existingByDay.set(day.getTime(), taken);
  }

  if (slotsToCreate.length === 0) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      "All generated slots overlap with existing slots."
    );
  }

  const createdSlots = await prisma.slot.createMany({
    data: slotsToCreate,
  });

  return {
    count: createdSlots.count,
    skipped,
    skippedDates: Array.from(skippedDates).sort(),
    totalDays,
    startDate: rangeStart.toISOString().slice(0, 10),
    endDate: rangeEnd.toISOString().slice(0, 10),
    counterId: counterId || null,
  };
};

const getSlots = async (query: any) => {
  const {
    salonId,
    date,
    startDate,
    endDate,
    status,
    serviceId,
    counterId,
    upcomingOnly,
  } = query;

  const whereConditions: any = {};
  if (salonId) whereConditions.salonId = salonId;
  if (date) {
    whereConditions.date = toCalendarDate(date, "date");
  } else if (startDate || endDate) {
    whereConditions.date = {
      ...(startDate ? { gte: toCalendarDate(startDate, "start date") } : {}),
      ...(endDate ? { lte: toCalendarDate(endDate, "end date") } : {}),
    };
  }
  if (status) whereConditions.status = status;
  if (serviceId) whereConditions.serviceId = serviceId;
  if (counterId) whereConditions.counterId = counterId;

  const slots = await prisma.slot.findMany({
    where: whereConditions,
    include: {
      service: {
        select: {
          id: true,
          name: true,
        },
      },
      counter: {
        select: {
          id: true,
          name: true,
          code: true,
        },
      },
    },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
  });

  // A booking screen should not offer this morning's 9am at half past four.
  // The filter is here rather than in the WHERE clause because `startTime` is a
  // string the database cannot compare against a timestamp, and it is opt-in
  // because the owner's slot manager still needs to see the whole day.
  if (upcomingOnly === true || upcomingOnly === "true") {
    const now = new Date();
    return slots.filter((slot) => !hasSlotStarted(slot, now));
  }

  return slots;
};

const updateSlotStatus = async (userId: string, userRole: string, slotId: string, payload: any) => {
  if (userRole !== UserRole.SALON_OWNER) {
    throw new ApiError(StatusCodes.FORBIDDEN, "Only salon owners can manage slot status");
  }

  const slot = await prisma.slot.findUnique({
    where: { id: slotId },
    include: { salon: true },
  });

  if (!slot) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Slot not found");
  }

  const salonOwner = await prisma.salonOwner.findUnique({
    where: { userId },
  });

  if (!salonOwner || slot.salon.ownerId !== salonOwner.id) {
    throw new ApiError(StatusCodes.FORBIDDEN, "You do not own this salon");
  }

  if (slot.isBooked && payload.status !== "COMPLETED" && payload.status !== "CANCELLED") {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Cannot freely change status of a booked slot");
  }

  const updatedSlot = await prisma.slot.update({
    where: { id: slotId },
    data: { status: payload.status as SlotStatus },
  });

  return updatedSlot;
};

const deleteSlot = async (userId: string, userRole: string, slotId: string) => {
  if (userRole !== UserRole.SALON_OWNER) {
    throw new ApiError(StatusCodes.FORBIDDEN, "Only salon owners can delete slots");
  }

  const slot = await prisma.slot.findUnique({
    where: { id: slotId },
    include: { salon: true },
  });

  if (!slot) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Slot not found");
  }

  const salonOwner = await prisma.salonOwner.findUnique({
    where: { userId },
  });

  if (!salonOwner || slot.salon.ownerId !== salonOwner.id) {
    throw new ApiError(StatusCodes.FORBIDDEN, "You do not own this salon");
  }

  if (slot.isBooked) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Cannot delete a booked slot. Please block it or cancel the booking instead.");
  }

  await prisma.slot.delete({
    where: { id: slotId },
  });

  return { message: "Slot deleted successfully" };
};

const deleteBulkSlots = async (userId: string, userRole: string, slotIds: string[]) => {
  if (userRole !== UserRole.SALON_OWNER) {
    throw new ApiError(StatusCodes.FORBIDDEN, "Only salon owners can delete slots");
  }

  const salonOwner = await prisma.salonOwner.findUnique({
    where: { userId },
  });

  if (!salonOwner) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Salon owner profile not found");
  }

  // Verify ownership of the slots and that they are not booked
  const slotsToDelete = await prisma.slot.findMany({
    where: {
      id: { in: slotIds },
      salon: {
        ownerId: salonOwner.id,
      },
      isBooked: false, // Ensure we only delete unbooked slots
    },
  });

  if (slotsToDelete.length === 0) {
    return { message: "No valid unbooked slots found to delete." };
  }

  const validSlotIds = slotsToDelete.map(slot => slot.id);

  await prisma.slot.deleteMany({
    where: {
      id: { in: validSlotIds },
    },
  });

  return { message: `${validSlotIds.length} slot(s) deleted successfully` };
};

export const SlotService = {
  bulkCreateSlots,
  getSlots,
  updateSlotStatus,
  deleteSlot,
  deleteBulkSlots,
};
