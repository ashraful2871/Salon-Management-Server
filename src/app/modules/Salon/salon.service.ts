import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";

const createSalon = async (userId: string, payload: any) => {
  // Check if user is salon owner
  const salonOwner = await prisma.salonOwner.findUnique({
    where: { userId },
  });

  if (!salonOwner) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "Only salon owners can create salons",
    );
  }

  const salon = await prisma.salon.create({
    data: {
      name: payload.name,
      description: payload.description,
      address: payload.address,
      city: payload.city,
      state: payload.state,
      zipCode: payload.zipCode,
      phone: payload.phone,
      email: payload.email,
      images: payload.images ?? [],
      operatingHours: payload.operatingHours,
      ownerId: salonOwner.id,
    },
  });

  return salon;
};

const getAllSalons = async (query: any) => {
  const { page = 1, limit = 10, searchTerm, city, status } = query;
  const skip = (Number(page) - 1) * Number(limit);

  const whereConditions: any = {
    isDeleted: false,
  };

  if (searchTerm) {
    whereConditions.OR = [
      { name: { contains: searchTerm, mode: "insensitive" } },
      { description: { contains: searchTerm, mode: "insensitive" } },
      { city: { contains: searchTerm, mode: "insensitive" } },
    ];
  }

  if (city) {
    whereConditions.city = { contains: city, mode: "insensitive" };
  }

  if (status) {
    whereConditions.status = status;
  } else {
    // By default, only show active salons to public
    whereConditions.status = "ACTIVE";
  }

  const [salons, total] = await Promise.all([
    prisma.salon.findMany({
      // where: whereConditions,
      // skip,
      // take: Number(limit),
      include: {
        owner: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                phone: true,
              },
            },
          },
        },
        services: {
          where: { isDeleted: false, isActive: true },
          orderBy: { createdAt: "desc" },
        },
        staff: {
          where: { isDeleted: false },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                phone: true,
                profilePhoto: true,
              },
            },
          },
        },
        counters: {
          where: { isDeleted: false },
          orderBy: { createdAt: "desc" },
        },
        _count: {
          select: {
            services: true,
            staff: true,
            reviews: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.salon.count({ where: whereConditions }),
  ]);

  return {
    meta: {
      page: Number(page),
      limit: Number(limit),
      total,
    },
    data: salons,
  };
};

const getMySalons = async (userId: string, query: any) => {
  const { page = 1, limit = 10 } = query;
  const skip = (Number(page) - 1) * Number(limit);

  // ✅ Get salon owner by userId
  const salonOwner = await prisma.salonOwner.findUnique({
    where: { userId },
  });

  if (!salonOwner) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "Only salon owners can access this route",
    );
  }

  const [salons, total] = await Promise.all([
    prisma.salon.findMany({
      where: {
        ownerId: salonOwner.id,
        isDeleted: false,
      },
      skip,
      take: Number(limit),
      include: {
        // ✅ Owner info
        owner: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                phone: true,
                profilePhoto: true,
              },
            },
          },
        },

        // ✅ Services
        services: {
          where: { isDeleted: false, isActive: true },
          orderBy: { createdAt: "desc" },
        },

        // ✅ Staff with user info + staff services
        staff: {
          where: { isDeleted: false },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                phone: true,
                profilePhoto: true,
              },
            },
            staffServices: {
              include: {
                service: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
        },
        // ✅ Counters
        counters: {
          where: { isDeleted: false },
          orderBy: { createdAt: "desc" },
        },

        // ✅ Appointments (optional but useful)
        appointments: {
          orderBy: { createdAt: "desc" },
          take: 10, // ✅ last 10 appointments only (you can remove take if you want all)
        },

        // ✅ Reviews (last 10 reviews)
        reviews: {
          orderBy: { createdAt: "desc" },
          take: 10,
          include: {
            customer: {
              select: {
                id: true,
                name: true,
                profilePhoto: true,
              },
            },
          },
        },

        // Counts
        _count: {
          select: {
            services: true,
            staff: true,
            reviews: true,
            appointments: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),

    prisma.salon.count({
      where: {
        ownerId: salonOwner.id,
        isDeleted: false,
      },
    }),
  ]);

  return {
    meta: {
      page: Number(page),
      limit: Number(limit),
      total,
    },
    data: salons,
  };
};

const getSalonById = async (id: string) => {
  const salon = await prisma.salon.findUnique({
    where: {
      id,
      isDeleted: false,
    },
    include: {
      owner: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
            },
          },
        },
      },
      services: {
        where: { isDeleted: false, isActive: true },
      },
      staff: {
        where: { isDeleted: false },
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
      reviews: {
        include: {
          customer: {
            select: {
              id: true,
              name: true,
              profilePhoto: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 10,
      },
    },
  });

  if (!salon) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Salon not found");
  }

  return salon;
};

const updateSalon = async (userId: string, salonId: string, payload: any) => {
  // Check if salon exists and belongs to the user
  const salonOwner = await prisma.salonOwner.findUnique({
    where: { userId },
  });

  if (!salonOwner) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "Only salon owners can update salons",
    );
  }

  const salon = await prisma.salon.findUnique({
    where: {
      id: salonId,
      isDeleted: false,
    },
  });

  if (!salon) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Salon not found");
  }

  if (salon.ownerId !== salonOwner.id) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "You can only update your own salons",
    );
  }

  const result = await prisma.salon.update({
    where: { id: salonId },
    data: payload,
  });

  return result;
};

const updateSalonStatus = async (salonId: string, status: string) => {
  const salon = await prisma.salon.findUnique({
    where: {
      id: salonId,
      isDeleted: false,
    },
  });

  if (!salon) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Salon not found");
  }

  const result = await prisma.salon.update({
    where: { id: salonId },
    data: { status: status as any },
  });

  return result;
};

const deleteSalon = async (
  userId: string,
  userRole: string,
  salonId: string,
) => {
  const salon = await prisma.salon.findUnique({
    where: {
      id: salonId,
      isDeleted: false,
    },
  });

  if (!salon) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Salon not found");
  }

  // Check ownership if not admin
  if (userRole !== "ADMIN") {
    const salonOwner = await prisma.salonOwner.findUnique({
      where: { id: userId },
    });

    if (!salonOwner || salon.ownerId !== salonOwner.id) {
      throw new ApiError(
        StatusCodes.FORBIDDEN,
        "You can only delete your own salons",
      );
    }
  }

  // Soft delete
  await prisma.salon.update({
    where: { id: salonId },
    data: { isDeleted: true },
  });

  return null;
};

export const SalonService = {
  createSalon,
  getAllSalons,
  getMySalons,
  getSalonById,
  updateSalon,
  updateSalonStatus,
  deleteSalon,
};
