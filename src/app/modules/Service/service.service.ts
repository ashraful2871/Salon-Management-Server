import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { toMinor } from "../../utils/money";
import { scheduleReindex } from "../AI-Suggestion/ai.indexer";
import {
  AccessUser,
  assertSalonPermission,
  scopeSalonIds,
} from "../../utils/salonAccess";

/**
 * The API takes and returns taka, the column holds integer poisha. Converting
 * on the way in keeps the public contract unchanged; `sendResponse` puts the
 * taka field back on the way out.
 */
const withMinorPrice = (payload: any) => {
  const { price, ...rest } = payload ?? {};
  return price === undefined ? rest : { ...rest, priceMinor: toMinor(price) };
};

const createService = async (user: AccessUser, payload: any) => {
  await assertSalonPermission(user, payload.salonId, "services.edit");

  const service = await prisma.service.create({
    data: withMinorPrice(payload),
  });

  // What a salon offers is what AI search matches on.
  scheduleReindex(service.salonId, "service.created");

  return service;
};

const getAllServices = async (query: any) => {
  const { page = 1, limit = 10, searchTerm, salonId, category } = query;
  const skip = (Number(page) - 1) * Number(limit);

  const whereConditions: any = {
    isDeleted: false,
    isActive: true,
  };

  if (searchTerm) {
    whereConditions.OR = [
      { name: { contains: searchTerm, mode: "insensitive" } },
      { description: { contains: searchTerm, mode: "insensitive" } },
    ];
  }

  if (salonId) {
    whereConditions.salonId = salonId;
  }

  if (category) {
    whereConditions.category = category;
  }

  const [services, total] = await Promise.all([
    prisma.service.findMany({
      where: whereConditions,
      skip,
      take: Number(limit),
      include: {
        salon: {
          select: {
            id: true,
            name: true,
            address: true,
            city: true,
            phone: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.service.count({ where: whereConditions }),
  ]);

  return {
    meta: {
      page: Number(page),
      limit: Number(limit),
      total,
    },
    data: services,
  };
};

const getServiceById = async (id: string) => {
  const service = await prisma.service.findUnique({
    where: {
      id,
      isDeleted: false,
    },
    include: {
      salon: true,
      staffServices: {
        include: {
          staff: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  profilePhoto: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!service) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Service not found");
  }

  return service;
};

const updateService = async (
  user: AccessUser,
  serviceId: string,
  payload: any,
) => {
  const service = await prisma.service.findUnique({
    where: {
      id: serviceId,
      isDeleted: false,
    },
  });

  if (!service) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Service not found");
  }

  // Switching a service on or off is a lighter permission than editing it.
  const onlyToggle = Object.keys(payload ?? {}).every((key) => key === "isActive");
  await assertSalonPermission(
    user,
    service.salonId,
    onlyToggle ? "services.toggle" : "services.edit",
  );

  const result = await prisma.service.update({
    where: { id: serviceId },
    data: withMinorPrice(payload),
  });

  scheduleReindex(service.salonId, "service.updated");

  return result;
};

const deleteService = async (user: AccessUser, serviceId: string) => {
  const service = await prisma.service.findUnique({
    where: {
      id: serviceId,
      isDeleted: false,
    },
  });

  if (!service) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Service not found");
  }

  await assertSalonPermission(user, service.salonId, "services.edit");

  // Soft delete
  await prisma.service.update({
    where: { id: serviceId },
    data: { isDeleted: true },
  });

  scheduleReindex(service.salonId, "service.deleted");

  return null;
};

const getMyServices = async (user: AccessUser, query: any) => {
  const salonIds =
    (await scopeSalonIds(user, "services.toggle", query.salonId)) ?? [];

  const { page = 1, limit = 10, searchTerm, category } = query;
  const skip = (Number(page) - 1) * Number(limit);

  const whereConditions: any = {
    isDeleted: false,
    isActive: true,
    salonId: { in: salonIds },
  };

  if (searchTerm) {
    whereConditions.OR = [
      { name: { contains: searchTerm, mode: "insensitive" } },
      { description: { contains: searchTerm, mode: "insensitive" } },
    ];
  }

  if (category) {
    whereConditions.category = category;
  }

  const [services, total] = await Promise.all([
    prisma.service.findMany({
      where: whereConditions,
      skip,
      take: Number(limit),
      include: {
        salon: {
          select: {
            id: true,
            name: true,
            address: true,
            city: true,
            phone: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.service.count({ where: whereConditions }),
  ]);

  return {
    meta: {
      page: Number(page),
      limit: Number(limit),
      total,
    },
    data: services,
  };
};

export const ServiceService = {
  createService,
  getAllServices,
  getMyServices,
  getServiceById,
  updateService,
  deleteService,
};
