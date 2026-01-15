import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";

const createService = async (userId: string, payload: any) => {
  // Verify salon ownership
  const salonOwner = await prisma.salonOwner.findUnique({
    where: { id: userId },
  });

  if (!salonOwner) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "Only salon owners can create services"
    );
  }

  const salon = await prisma.salon.findUnique({
    where: {
      id: payload.salonId,
      isDeleted: false,
    },
  });

  if (!salon) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Salon not found");
  }

  if (salon.ownerId !== salonOwner.id) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "You can only create services for your own salons"
    );
  }

  const service = await prisma.service.create({
    data: payload,
  });

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
  userId: string,
  serviceId: string,
  payload: any
) => {
  // Verify ownership
  const salonOwner = await prisma.salonOwner.findUnique({
    where: { id: userId },
  });

  if (!salonOwner) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "Only salon owners can update services"
    );
  }

  const service = await prisma.service.findUnique({
    where: {
      id: serviceId,
      isDeleted: false,
    },
    include: { salon: true },
  });

  if (!service) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Service not found");
  }

  if (service.salon.ownerId !== salonOwner.id) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "You can only update your own services"
    );
  }

  const result = await prisma.service.update({
    where: { id: serviceId },
    data: payload,
  });

  return result;
};

const deleteService = async (userId: string, serviceId: string) => {
  // Verify ownership
  const salonOwner = await prisma.salonOwner.findUnique({
    where: { id: userId },
  });

  if (!salonOwner) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "Only salon owners can delete services"
    );
  }

  const service = await prisma.service.findUnique({
    where: {
      id: serviceId,
      isDeleted: false,
    },
    include: { salon: true },
  });

  if (!service) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Service not found");
  }

  if (service.salon.ownerId !== salonOwner.id) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "You can only delete your own services"
    );
  }

  // Soft delete
  await prisma.service.update({
    where: { id: serviceId },
    data: { isDeleted: true },
  });

  return null;
};

export const ServiceService = {
  createService,
  getAllServices,
  getServiceById,
  updateService,
  deleteService,
};
