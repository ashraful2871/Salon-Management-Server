import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";

const createCounter = async (userId: string, payload: any) => {
  const salonOwner = await prisma.salonOwner.findUniqueOrThrow({
    where: {
      userId,
    },
  });

  if (!salonOwner) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Salon owner not found");
  }

  const salon = await prisma.salon.findFirst({
    where: {
      id: payload.salonId,
      ownerId: salonOwner.id,
      isDeleted: false,
    },
  });

  if (!salon) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Salon not found");
  }

  const counter = await prisma.counter.create({
    data: {
      salonId: payload.salonId,
      name: payload.name,
      code: payload.code,
    },
  });

  return counter;
};

export const CounterService = {
  createCounter,
};
