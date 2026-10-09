import { StatusCodes } from "http-status-codes";
import { Prisma } from "@prisma/client";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";

/** Only PUBLISHED reviews are shown, and only they count toward a rating. */
const PUBLISHED = { status: "PUBLISHED" } as const;

const ratingOf = async (tx: Prisma.TransactionClient, where: Prisma.ReviewWhereInput) => {
  const agg = await tx.review.aggregate({
    where: { ...where, ...PUBLISHED },
    _avg: { rating: true },
    _count: { _all: true },
  });
  return { rating: agg._avg.rating ?? 0, totalReviews: agg._count._all };
};

/** Salon `rating` / `totalReviews` from its PUBLISHED reviews. Create, hide and restore call it. */
export const recomputeSalonRating = async (tx: Prisma.TransactionClient, salonId: string) => {
  const data = await ratingOf(tx, { salonId });
  await tx.salon.update({ where: { id: salonId }, data });
  return data;
};

export const recomputeStaffRating = async (tx: Prisma.TransactionClient, staffId: string) => {
  const data = await ratingOf(tx, { staffId });
  await tx.staff.update({ where: { id: staffId }, data });
  return data;
};

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
      "You can only review your own appointments",
    );
  }

  if (appointment.status !== "COMPLETED") {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "You can only review completed appointments",
    );
  }

  // Check if review already exists
  const existingReview = await prisma.review.findUnique({
    where: { appointmentId: payload.appointmentId },
  });

  if (existingReview) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      "Review already exists for this appointment",
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

      await recomputeSalonRating(tx, appointment.salonId);
      if (appointment.staffId) await recomputeStaffRating(tx, appointment.staffId);

      return review;
    },
  );

  return result;
};

const getAllReviews = async (query: any) => {
  const { page = 1, limit = 10, salonId, staffId } = query;
  const skip = (Number(page) - 1) * Number(limit);

  // Public: reviews of a salon that is not live (suspended, pending, deleted)
  // stay hidden with it.
  const whereConditions: any = { ...PUBLISHED, salon: { status: "ACTIVE", isDeleted: false } };

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
  const review = await prisma.review.findFirst({
    where: { id, ...PUBLISHED },
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

const getReviewsBySalonId = async (salonId: string, query: any) => {
  const { page = 1, limit = 10 } = query;
  const skip = (Number(page) - 1) * Number(limit);

  const whereConditions: any = { salonId, ...PUBLISHED };

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

const getReviewsByStaffId = async (staffId: string, query: any) => {
  const { page = 1, limit = 10 } = query;
  const skip = (Number(page) - 1) * Number(limit);

  const whereConditions: any = { staffId, ...PUBLISHED };

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

export const REPORT_REASONS = ["ABUSIVE", "PERSONAL_INFO", "SPAM", "FAKE", "OTHER"] as const;

/**
 * A customer, or the owner of the reviewed salon, flags a review for the
 * moderators. One report per user per review; the review stays up until an
 * admin hides it.
 */
const reportReview = async (
  user: { userId: string; role: string },
  reviewId: string,
  body: { reason: (typeof REPORT_REASONS)[number]; note?: string },
) => {
  const review = await prisma.review.findFirst({
    where: { id: reviewId, ...PUBLISHED },
    select: { id: true, customerId: true, salon: { select: { owner: { select: { userId: true } } } } },
  });
  if (!review) throw new ApiError(StatusCodes.NOT_FOUND, "Review not found");

  if (user.role === "SALON_OWNER" && review.salon.owner.userId !== user.userId) {
    throw new ApiError(StatusCodes.FORBIDDEN, "You can only report reviews of your own salon");
  }
  if (review.customerId === user.userId) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "You can't report your own review");
  }

  try {
    await prisma.$transaction([
      prisma.reviewReport.create({
        data: { reviewId, reporterId: user.userId, reason: body.reason, note: body.note || null },
      }),
      // A new report puts a review a moderator kept back in the Reported queue.
      prisma.review.update({ where: { id: reviewId }, data: { reportCount: { increment: 1 }, moderatedAt: null } }),
    ]);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new ApiError(StatusCodes.CONFLICT, "You have already reported this review");
    }
    throw err;
  }
};

export const ReviewService = {
  createReview,
  reportReview,
  getAllReviews,
  getReviewById,
  getReviewsBySalonId,
  getReviewsByStaffId,
};
