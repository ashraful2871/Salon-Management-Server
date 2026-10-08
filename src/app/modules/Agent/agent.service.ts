import prisma from "../../shared/prisma";
import { Prisma } from "@prisma/client";

const getAllAgents = async (query: any) => {
  const { searchTerm, page = 1, limit = 10 } = query;
  const skip = (Number(page) - 1) * Number(limit);

  const andConditions: Prisma.AgentWhereInput[] = [];

  if (searchTerm) {
    andConditions.push({
      OR: [
        { user: { name: { contains: searchTerm, mode: "insensitive" } } },
        { user: { email: { contains: searchTerm, mode: "insensitive" } } },
        { area: { contains: searchTerm, mode: "insensitive" } },
      ],
    });
  }

  const whereConditions: Prisma.AgentWhereInput =
    andConditions.length > 0 ? { AND: andConditions } : {};

  const [agents, total] = await Promise.all([
    prisma.agent.findMany({
      where: whereConditions,
      skip,
      take: Number(limit),
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            gender: true,
            profilePhoto: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.agent.count({ where: whereConditions }),
  ]);

  return {
    meta: {
      total,
      page: Number(page),
      limit: Number(limit),
    },
    data: agents,
  };
};

export const AgentService = {
  getAllAgents,
};
