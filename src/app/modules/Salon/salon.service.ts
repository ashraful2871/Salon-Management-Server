import { Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { scheduleReindex } from "../AI-Suggestion/ai.indexer";
import { countNearbySalons, findNearbySalonIds } from "./salon.geo";
import { SalonListQuery } from "./salon.validation";

// Fields an owner may change through PATCH /salons/:id. Status, rating,
// totalReviews, ownerId, isDeleted and noShowSalonSharePct are deliberately
// absent. The deposit fields are here because the dashboard Settings page
// sends them. Coordinates go through their own branch (they also stamp
// locationAccuracy and locationUpdatedAt).
const OWNER_EDITABLE_FIELDS = [
  "name",
  "description",
  "website",
  "address",
  "division",
  "district",
  "area",
  "city",
  "state",
  "zipCode",
  "phone",
  "email",
  "images",
  "operatingHours",
  "depositMinor",
  "depositPercent",
  "cancellationWindowMin",
] as const;

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
      area: payload.area,
      district: payload.district,
      division: payload.division,
      city: payload.city,
      state: payload.state,
      zipCode: payload.zipCode,
      phone: payload.phone,
      email: payload.email,
      images: payload.images ?? [],
      operatingHours: payload.operatingHours,
      ownerId: salonOwner.id,
      ...(payload.latitude !== undefined && {
        latitude: payload.latitude,
        longitude: payload.longitude,
        locationAccuracy: "EXACT",
        locationUpdatedAt: new Date(),
      }),
    },
  });

  // A new salon awaits approval, so this usually does nothing; the status
  // change that activates it re-embeds it.
  scheduleReindex(salon.id, "salon.created");

  return salon;
};

const getAllSalons = async (query: SalonListQuery, user?: any) => {
  const {
    page,
    limit,
    searchTerm,
    city,
    area,
    division,
    district,
    lat,
    lng,
    radiusKm,
    sort,
  } = query;

  // Only ADMIN/AGENT may pick a status (or see every status by omitting it).
  // Everyone else gets ACTIVE, whatever they send.
  const isStaff = user?.role === "ADMIN" || user?.role === "AGENT";
  const status = isStaff ? query.status : "ACTIVE";

  // An agent is scoped to their area. The scope is ANDed with any ?area=
  // filter, never replaced by it.
  let agentArea: string | undefined;
  if (user?.role === "AGENT") {
    const agent = await prisma.agent.findUnique({
      where: { userId: user.userId },
    });
    if (agent) {
      agentArea = agent.area;
    }
  }

  // Owner and staff contact details are for ADMIN/AGENT (the approval page),
  // not for anonymous visitors.
  const include = {
    owner: {
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: isStaff,
            phone: isStaff,
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
            email: isStaff,
            phone: isStaff,
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
  } satisfies Prisma.SalonInclude;

  // Nearby mode: PostGIS picks, orders and pages the ids; Prisma loads them.
  if (lat !== undefined && lng !== undefined) {
    const args = {
      lat,
      lng,
      radiusKm,
      page,
      limit,
      sort: sort ?? "distance",
      status,
      agentArea,
      searchTerm,
      city,
      division,
      district,
      area,
    };
    const rows = await findNearbySalonIds(args);

    let total: number;
    if (rows.length > 0) {
      total = rows[0].total;
    } else {
      total = page === 1 ? 0 : await countNearbySalons(args);
    }

    const salons = rows.length
      ? await prisma.salon.findMany({
          where: { id: { in: rows.map((r) => r.id) } },
          include,
        })
      : [];

    // findMany ignores the SQL order, so restore it and attach the distance.
    const byId = new Map(salons.map((s) => [s.id, s]));
    const data = rows.flatMap((r) => {
      const s = byId.get(r.id);
      return s ? [{ ...s, distanceMeters: Math.round(r.distance_m) }] : [];
    });

    return { meta: { page, limit, total }, data };
  }

  const whereConditions: Prisma.SalonWhereInput = {
    isDeleted: false,
  };

  if (status) {
    whereConditions.status = status;
  }

  const areaConditions: Prisma.SalonWhereInput[] = [
    ...(agentArea ? [{ area: agentArea }] : []),
    ...(area
      ? [{ area: { contains: area, mode: Prisma.QueryMode.insensitive } }]
      : []),
  ];
  if (areaConditions.length) {
    whereConditions.AND = areaConditions;
  }

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

  if (division) {
    whereConditions.division = { contains: division, mode: "insensitive" };
  }

  if (district) {
    whereConditions.district = { contains: district, mode: "insensitive" };
  }

  const orderBy: Prisma.SalonOrderByWithRelationInput[] =
    sort === "rating"
      ? [{ rating: "desc" }, { totalReviews: "desc" }, { id: "asc" }]
      : [{ createdAt: "desc" }, { id: "asc" }];

  const [salons, total] = await Promise.all([
    prisma.salon.findMany({
      where: whereConditions,
      skip: (page - 1) * limit,
      take: limit,
      include,
      orderBy,
    }),
    prisma.salon.count({ where: whereConditions }),
  ]);

  return {
    meta: {
      page,
      limit,
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
            staffServices: {
              include: {
                service: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
        },
        counters: {
          where: { isDeleted: false },
          orderBy: { createdAt: "desc" },
        },

        appointments: {
          orderBy: { createdAt: "desc" },
          take: 10,
        },

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
      counters: {
        where: { isDeleted: false },
        orderBy: { createdAt: "desc" },
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

  // Pick only what an owner may edit. Writing req.body straight through would
  // let an owner set status, rating, totalReviews, ownerId and the like.
  const data: Prisma.SalonUpdateInput = {};
  for (const field of OWNER_EDITABLE_FIELDS) {
    if (payload[field] !== undefined) {
      (data as Record<string, unknown>)[field] = payload[field];
    }
  }

  if (payload.latitude !== undefined && payload.longitude !== undefined) {
    data.latitude = payload.latitude;
    data.longitude = payload.longitude;
    data.locationAccuracy = "EXACT";
    data.locationUpdatedAt = new Date();
  }

  const result = await prisma.salon.update({
    where: { id: salonId },
    data,
  });

  // Skipped by the indexer when nothing it embeds (name, place, description,
  // services) changed, so settings-only saves cost no Gemini call.
  scheduleReindex(salonId, "salon.updated");

  return result;
};

const updateSalonLocation = async (
  userId: string,
  salonId: string,
  payload: { latitude: number; longitude: number },
) => {
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

  // No re-embed: coordinates are not part of the embedded salon text.
  const result = await prisma.salon.update({
    where: { id: salonId },
    data: {
      latitude: payload.latitude,
      longitude: payload.longitude,
      locationAccuracy: "EXACT",
      locationUpdatedAt: new Date(),
    },
  });

  return result;
};

const updateSalonStatus = async (salonId: string, status: string, user?: any) => {
  const salon = await prisma.salon.findUnique({
    where: {
      id: salonId,
      isDeleted: false,
    },
  });

  if (!salon) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Salon not found");
  }

  if (user?.role === "AGENT") {
    const agent = await prisma.agent.findUnique({
      where: { userId: user.userId },
    });
    if (!agent || agent.area !== salon.area) {
      throw new ApiError(StatusCodes.FORBIDDEN, "You can only manage salons in your assigned area");
    }
  }

  const result = await prisma.salon.update({
    where: { id: salonId },
    data: { status: status as any },
  });

  // Approval is when a salon becomes searchable.
  scheduleReindex(salonId, "salon.status");

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
      where: { userId },
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
  updateSalonLocation,
  updateSalonStatus,
  deleteSalon,
};
