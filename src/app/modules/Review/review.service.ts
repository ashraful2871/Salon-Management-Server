import { StatusCodes } from "http-status-codes";
import { Prisma } from "@prisma/client";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";

const createReview = async (userId: string, payload: any) => {
  // Verify appointment exists and is completed
  const appointment = await prisma.appointment.findUnique({
    where: { id: payload.appointmentId },
  });

  if (!appointment) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Appointment not found");
  }

  if (appointment.customerId !== userId) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "You can only review your own appointments"
    );
  }

  if (appointment.status !== "COMPLETED") {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "You can only review completed appointments"
    );
  }

  // Check if review already exists
  const existingReview = await prisma.review.findUnique({
    where: { appointmentId: payload.appointmentId },
  });

  if (existingReview) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      "Review already exists for this appointment"
    );
  }

  // Create review in a transaction and update ratings
  const result = await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const review = await tx.review.create({
        data: {
          appointmentId: payload.appointmentId,
          customerId: userId,
          salonId: appointment.salonId,
          staffId: appointment.staffId,
          rating: payload.rating,
          comment: payload.comment,
        },
        include: {
          customer: {
            select: {
              id: true,
              name: true,
              profilePhoto: true,
            },
          },
          salon: {
            select: {
              id: true,
              name: true,
            },
          },
          staff: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
      });

      // Update salon rating
      const salonReviews = await tx.review.findMany({
        where: { salonId: appointment.salonId },
        select: { rating: true },
      });
      const salonAvgRating =
        salonReviews.reduce((sum: number, r: any) => sum + r.rating, 0) /
        salonReviews.length;
      await tx.salon.update({
        where: { id: appointment.salonId },
        data: {
          rating: salonAvgRating,
          totalReviews: salonReviews.length,
        },
      });

      // Update staff rating if applicable
      if (appointment.staffId) {
        const staffReviews = await tx.review.findMany({
          where: { staffId: appointment.staffId },
          select: { rating: true },
        });
        const staffAvgRating =
          staffReviews.reduce((sum: number, r: any) => sum + r.rating, 0) /
          staffReviews.length;
        await tx.staff.update({
          where: { id: appointment.staffId },
          data: {
            rating: staffAvgRating,
            totalReviews: staffReviews.length,
          },
        });
      }

      return review;
    }
  );

  return result;
};

const getAllReviews = async (query: any) => {
  const { page = 1, limit = 10, salonId, staffId } = query;
  const skip = (Number(page) - 1) * Number(limit);

  const whereConditions: any = {};

  if (salonId) {
    whereConditions.salonId = salonId;
  }

  if (staffId) {
    whereConditions.staffId = staffId;
  }

  const [reviews, total] = await Promise.all([
    prisma.review.findMany({
      where: whereConditions,
      skip,
      take: Number(limit),
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            profilePhoto: true,
          },
        },
        salon: {
          select: {
            id: true,
            name: true,
          },
        },
        staff: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.review.count({ where: whereConditions }),
  ]);

  return {
    meta: {
      page: Number(page),
      limit: Number(limit),
      total,
    },
    data: reviews,
  };
};

const getReviewById = async (id: string) => {
  const review = await prisma.review.findUnique({
    where: { id },
    include: {
      customer: {
        select: {
          id: true,
          name: true,
          profilePhoto: true,
          email: true,
        },
      },
      salon: true,
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
      appointment: {
        select: {
          id: true,
          appointmentDate: true,
          service: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  });

  if (!review) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Review not found");
  }

  return review;
};

export const ReviewService = {
  createReview,
  getAllReviews,
  getReviewById,
};
