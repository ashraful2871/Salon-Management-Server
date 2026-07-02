import bcrypt from "bcryptjs";
import ApiError from "../../Error/error";
import { StatusCodes } from "http-status-codes";
import prisma from "../../shared/prisma";
import { Prisma } from "@prisma/client";

const createAgent = async (payload: any) => {
  const { name, email, password, division, district, area, phone, gender } =
    payload;

  const existingUser = await prisma.user.findUnique({
    where: { email },
  });

  if (existingUser) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      "User with this email already exists",
    );
  }

  const hashedPassword = await bcrypt.hash(password, Number(12));

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role: "AGENT",
        phone,
        gender,
      },
    });

    const agent = await tx.agent.create({
      data: {
        userId: user.id,
        division,
        district,
        area,
      },
    });

    return { ...user, agent };
  });

  // Exclude password from the returned result
  const { password: _password, ...userWithoutPassword } = result;
  return userWithoutPassword;
};

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
  createAgent,
  getAllAgents,
};
