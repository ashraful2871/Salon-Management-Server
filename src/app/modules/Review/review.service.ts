import { StatusCodes } from "http-status-codes";
import { Prisma } from "@prisma/client";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { Request } from "express";
import config from "../../../config";
import { audit, diff } from "../../utils/audit";
import { sendEmail } from "../../utils/emailSender";
import { notifyBranch } from "../../utils/notify";
import { getReviewReplyTemplate } from "../../utils/emailTemplates";
import { assertSalonPermission, isBusinessRole, withAccessCache } from "../../utils/salonAccess";
import { buildAuditCtx } from "../Admin/admin.middleware";
import { REPLY_EDIT_WINDOW_MS } from "../Owner/owner.reviews";

/** Only PUBLISHED reviews are shown, and only they count toward a rating. */
const PUBLISHED = { status: "PUBLISHED" } as const;

/** Public reads show the reply but not who on the business wrote it. */
const PUBLIC_OMIT = { ownerReplyById: true } as const;

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

  const stars = "★".repeat(result.rating);
  void notifyBranch(result.salonId, "review.new", {
    title: `${stars} review for ${result.salon.name}`,
    body: `${result.customer.name || "A customer"}: ${result.comment ? `"${result.comment.slice(0, 160)}"` : `rated ${result.rating}/5`}`,
    link: "/dashboard/reviews",
    dedupeKey: `review.new:${result.id}`,
  });

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
      omit: PUBLIC_OMIT,
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
    omit: PUBLIC_OMIT,
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
      omit: PUBLIC_OMIT,
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
      omit: PUBLIC_OMIT,
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
    select: { id: true, customerId: true, salonId: true },
  });
  if (!review) throw new ApiError(StatusCodes.NOT_FOUND, "Review not found");

  if (isBusinessRole(user.role)) {
    await assertSalonPermission(user, review.salonId, "reviews.reply");
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

/**
 * POST (edit = false) or PATCH (edit = true) /reviews/:id/reply. One public
 * reply per review, from a business user holding reviews.reply at its salon;
 * only PUBLISHED reviews can be answered, and an edit is allowed for 24 h
 * after the first post (editing does not restart the clock).
 */
const replyToReview = async (req: Request, reviewId: string, text: string, edit: boolean) => {
  const user = withAccessCache(req);
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    select: {
      id: true,
      salonId: true,
      status: true,
      ownerReply: true,
      ownerRepliedAt: true,
      customer: { select: { name: true, email: true } },
      salon: { select: { name: true } },
    },
  });
  if (!review) throw new ApiError(StatusCodes.NOT_FOUND, "Review not found");
  await assertSalonPermission(user, review.salonId, "reviews.reply");
  if (review.status !== "PUBLISHED") {
    throw new ApiError(StatusCodes.CONFLICT, "This review is hidden, so it can't be answered");
  }

  const now = new Date();
  const editableSince = new Date(now.getTime() - REPLY_EDIT_WINDOW_MS);
  // Conditional writes: two people answering at once cannot both win.
  const { count } = await prisma.review.updateMany({
    where: edit
      ? { id: reviewId, ...PUBLISHED, ownerReply: { not: null }, ownerRepliedAt: { gte: editableSince } }
      : { id: reviewId, ...PUBLISHED, ownerReply: null },
    data: edit
      ? { ownerReply: text, ownerReplyById: user.userId }
      : { ownerReply: text, ownerRepliedAt: now, ownerReplyById: user.userId },
  });
  if (count === 0) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      edit
        ? review.ownerReply
          ? "A reply can only be edited for 24 hours after it is posted"
          : "There is no reply to edit yet"
        : "This review already has a reply - edit it instead",
    );
  }

  await audit(buildAuditCtx(req, user.role), {
    action: edit ? "review.reply_edit" : "review.reply",
    entityType: "review",
    entityId: reviewId,
    salonId: review.salonId,
    ...diff({ ownerReply: review.ownerReply }, { ownerReply: text }),
  });

  if (!edit && review.customer.email && !review.customer.email.endsWith("@walk-in.invalid")) {
    void sendEmail(
      review.customer.email,
      "The salon replied to your review",
      getReviewReplyTemplate({
        name: review.customer.name,
        salonName: review.salon.name,
        reply: text,
        salonUrl: `${config.frontend_url}/salons/${review.salonId}`,
      }),
    );
  }

  return {
    id: reviewId,
    salonId: review.salonId,
    ownerReply: text,
    ownerRepliedAt: edit ? review.ownerRepliedAt : now,
  };
};

export const ReviewService = {
  replyToReview,
  createReview,
  reportReview,
  getAllReviews,
  getReviewById,
  getReviewsBySalonId,
  getReviewsByStaffId,
};
