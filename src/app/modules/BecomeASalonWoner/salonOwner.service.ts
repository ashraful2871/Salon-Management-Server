import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { OwnerApplicationStatus, UserRole } from "@prisma/client";

const applySalonOwner = async (userId: string, payload: any) => {
  // Check user exists
  await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  // Check already applied
  const existing = await prisma.salonOwner.findUnique({
    where: { userId },
  });

  if (existing) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      "You have already applied for salon owner. You cannot apply again.",
    );
  }

  // Create new application (only once)
  const result = await prisma.salonOwner.create({
    data: {
      userId,
      businessName: payload.businessName,
      businessAddress: payload.businessAddress,
      businessPhone: payload.businessPhone,
      businessEmail: payload.businessEmail,
      documentUrl: payload.documentUrl,
      applicationStatus: OwnerApplicationStatus.PENDING,
      verificationStatus: false,
    },
  });

  return result;
};

const getMySalonOwnerApplication = async (userId: string) => {
  const application = await prisma.salonOwner.findUnique({
    where: { userId },
    include: {
      user: { select: { id: true, name: true, email: true, role: true } },
    },
  });

  if (!application) {
    throw new ApiError(
      StatusCodes.NOT_FOUND,
      "No salon owner application found",
    );
  }

  return application;
};

const getAllApplications = async (query: any) => {
  const { page = 1, limit = 10, status, search } = query;
  const skip = (Number(page) - 1) * Number(limit);

  const where: any = {};

  if (status) where.applicationStatus = status;

  if (search) {
    where.OR = [
      { businessName: { contains: search, mode: "insensitive" } },
      { businessEmail: { contains: search, mode: "insensitive" } },
      { businessPhone: { contains: search, mode: "insensitive" } },
      { user: { name: { contains: search, mode: "insensitive" } } },
      { user: { email: { contains: search, mode: "insensitive" } } },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.salonOwner.findMany({
      where,
      skip,
      take: Number(limit),
      include: {
        user: { select: { id: true, name: true, email: true, role: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.salonOwner.count({ where }),
  ]);

  return {
    meta: { page: Number(page), limit: Number(limit), total },
    data,
  };
};

const getApplicationById = async (id: string) => {
  const application = await prisma.salonOwner.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, name: true, email: true, role: true } },
    },
  });

  if (!application)
    throw new ApiError(StatusCodes.NOT_FOUND, "Application not found");
  return application;
};

const approveApplication = async (
  adminUserId: string,
  applicationId: string,
) => {
  // optional: ensure admin user exists
  // (your auth middleware already restricts ADMIN, so this is extra)
  const application = await prisma.salonOwner.findUnique({
    where: { id: applicationId },
    include: { user: true },
  });

  if (!application)
    throw new ApiError(StatusCodes.NOT_FOUND, "Application not found");

  if (application.applicationStatus === OwnerApplicationStatus.APPROVED) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Already approved");
  }

  const result = await prisma.$transaction(async (tx) => {
    const updatedApplication = await tx.salonOwner.update({
      where: { id: applicationId },
      data: {
        applicationStatus: OwnerApplicationStatus.APPROVED,
        verificationStatus: true,
        rejectionReason: null,
      },
    });

    //set user role to SALON_OWNER after approval
    await tx.user.update({
      where: { id: application.userId },
      data: { role: UserRole.SALON_OWNER },
    });

    return updatedApplication;
  });

  return result;
};

const rejectApplication = async (
  adminUserId: string,
  applicationId: string,
  payload: any,
) => {
  const application = await prisma.salonOwner.findUnique({
    where: { id: applicationId },
  });

  if (!application)
    throw new ApiError(StatusCodes.NOT_FOUND, "Application not found");

  if (application.applicationStatus === OwnerApplicationStatus.REJECTED) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Already rejected");
  }

  const result = await prisma.salonOwner.update({
    where: { id: applicationId },
    data: {
      applicationStatus: OwnerApplicationStatus.REJECTED,
      verificationStatus: false,
      rejectionReason: payload.rejectionReason,
    },
  });

  // keep user role as CUSTOMER (do nothing)
  return result;
};

export const SalonOwnerService = {
  applySalonOwner,
  getMySalonOwnerApplication,
  getAllApplications,
  getApplicationById,
  approveApplication,
  rejectApplication,
};
