import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { UserRole, SlotStatus } from "@prisma/client";

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

  const { date, startTime, endTime, duration, breakDuration } = payload;
  
  const targetDate = new Date(date);
  if (isNaN(targetDate.getTime())) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Invalid date format");
  }

  const parseTime = (timeStr: string) => {
    const [hours, minutes] = timeStr.split(':').map(Number);
    const d = new Date(targetDate);
    d.setHours(hours, minutes, 0, 0);
    return d;
  };

  const parsedStartTime = parseTime(startTime);
  const parsedEndTime = parseTime(endTime);

  if (parsedEndTime <= parsedStartTime) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "End time must be after start time");
  }

  const slotsToCreate = [];
  let currentStart = new Date(parsedStartTime);

  const formatTime = (d: Date) => {
    return d.toTimeString().substring(0, 5);
  };

  while (new Date(currentStart.getTime() + duration * 60000) <= parsedEndTime) {
    const currentEnd = new Date(currentStart.getTime() + duration * 60000);
    
    slotsToCreate.push({
      salonId: payload.salonId,
      date: targetDate,
      startTime: formatTime(currentStart),
      endTime: formatTime(currentEnd),
      status: SlotStatus.AVAILABLE,
    });

    currentStart = new Date(currentEnd.getTime() + (breakDuration || 0) * 60000);
  }

  if (slotsToCreate.length === 0) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Could not generate any slots with the provided settings");
  }

  const existingSlots = await prisma.slot.findMany({
    where: {
      salonId: payload.salonId,
      date: targetDate,
    },
  });

  const conflicts = slotsToCreate.filter(newSlot => {
    const newStart = parseTime(newSlot.startTime);
    const newEnd = parseTime(newSlot.endTime);

    return existingSlots.some(existing => {
      const existingStart = parseTime(existing.startTime);
      const existingEnd = parseTime(existing.endTime);

      return (newStart < existingEnd && existingStart < newEnd);
    });
  });

  if (conflicts.length > 0) {
    throw new ApiError(StatusCodes.CONFLICT, "Some generated slots overlap with existing slots.");
  }

  const createdSlots = await prisma.slot.createMany({
    data: slotsToCreate,
  });

  return createdSlots;
};

const getSlots = async (query: any) => {
  const { salonId, date, status } = query;

  const whereConditions: any = {};
  if (salonId) whereConditions.salonId = salonId;
  if (date) {
    whereConditions.date = new Date(date);
  }
  if (status) whereConditions.status = status;

  const slots = await prisma.slot.findMany({
    where: whereConditions,
    orderBy: { startTime: 'asc' },
  });

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

export const SlotService = {
  bulkCreateSlots,
  getSlots,
  updateSlotStatus,
  deleteSlot,
};
