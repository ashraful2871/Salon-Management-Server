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

  if (payload.code) {
    const isCodeExists = await prisma.counter.findFirst({
      where: {
        code: payload.code,
        isDeleted: false,
      },
    });

    if (isCodeExists) {
      throw new ApiError(
        StatusCodes.BAD_REQUEST,
        "Counter code already exists",
      );
    }
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

const getAllCounters = async (query: any) => {
  const { page = 1, limit = 10, salonId } = query;
  const skip = (Number(page) - 1) * Number(limit);

  const whereConditions: any = { isDeleted: false };

  if (salonId) {
    whereConditions.salonId = salonId;
  }

  const [counters, total] = await Promise.all([
    prisma.counter.findMany({
      where: whereConditions,
      skip,
      take: Number(limit),
      include: {
        salon: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.counter.count({ where: whereConditions }),
  ]);

  return {
    meta: {
      page: Number(page),
      limit: Number(limit),
      total,
    },
    data: counters,
  };
};

const getCounterById = async (id: string) => {
  const counter = await prisma.counter.findUnique({
    where: { id },
    include: {
      salon: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  if (!counter) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Counter not found");
  }

  return counter;
};

export const CounterService = {
  createCounter,
  getAllCounters,
  getCounterById,
};
