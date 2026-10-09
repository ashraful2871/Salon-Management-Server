import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { OwnerApplicationStatus, UserRole } from "@prisma/client";
import config from "../../../config";
import { sendEmail } from "../../utils/emailSender";
import { getOwnerApplicationDecisionTemplate } from "../../utils/emailTemplates";

/** Tells the applicant; never fails the decision it reports. */
const notifyApplicant = (
  user: { name: string; email: string },
  businessName: string | null,
  approved: boolean,
  reason?: string | null,
) => {
  const html = getOwnerApplicationDecisionTemplate({
    approved,
    name: user.name,
    businessName: businessName || "your salon",
    reason,
    link: approved
      ? `${config.frontend_url}/dashboard/store`
      : `${config.frontend_url}/become-salon-owner`,
    contactUrl: `${config.frontend_url}/contact`,
  });
  void sendEmail(
    user.email,
    approved
      ? "Your salon owner application is approved"
      : "Your salon owner application was not approved",
    html,
  ).catch(() => undefined);
};

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

  const [data, total, byStatus] = await Promise.all([
    prisma.salonOwner.findMany({
      where,
      skip,
      take: Number(limit),
      include: {
        user: {
          select: { id: true, name: true, email: true, phone: true, role: true, status: true, createdAt: true },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.salonOwner.count({ where }),
    // Chip counts: the same search, every status.
    prisma.salonOwner.groupBy({
      by: ["applicationStatus"],
      where: { ...where, applicationStatus: undefined },
      _count: { _all: true },
    }),
  ]);

  return {
    meta: {
      page: Number(page),
      limit: Number(limit),
      total,
      statusCounts: Object.fromEntries(
        byStatus.map((s) => [s.applicationStatus, s._count._all]),
      ),
    },
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

    /// set user role to SALON_OWNER after approval
    await tx.user.update({
      where: { id: application.userId },
      data: { role: UserRole.SALON_OWNER },
    });

    return updatedApplication;
  });

  notifyApplicant(application.user, application.businessName, true);

  return result;
};

const rejectApplication = async (
  adminUserId: string,
  applicationId: string,
  payload: any,
) => {
  const application = await prisma.salonOwner.findUnique({
    where: { id: applicationId },
    include: { user: { select: { name: true, email: true } } },
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

  notifyApplicant(application.user, application.businessName, false, payload.rejectionReason);
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
