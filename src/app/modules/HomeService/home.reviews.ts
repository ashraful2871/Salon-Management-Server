import { HomeBookingStatus, Prisma, ReviewStatus } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { notifyBranch } from "../../utils/notify";
import { recomputeHomeExpertRating, recomputeSalonRating } from "../Review/review.service";
import type { Actor } from "./home.booking";
import type { CreateReviewBody } from "./home.validation";

/**
 * Reviews of home visits. Same `reviews` table and moderation as salon
 * reviews (hide / restore in the back office, reports, owner reply); the
 * parent is the home booking (CHECK reviews_one_parent), the salon is the
 * booked branch, and the expert is `homeExpertId` — not `staffId`, so a home
 * review moves the expert's home rating, not their salon-floor one.
 */

const REVIEW_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 10;

const fail = (status: number, message: string, code: string) => ApiError.withCode(status, message, code);
const alreadyReviewed = () => fail(StatusCodes.CONFLICT, "You've already reviewed this visit.", "ALREADY_REVIEWED");

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/** POST /bookings/:id/review: COMPLETED, own booking, within 14 days, once. */
export const createHomeReview = async (actor: Actor, id: string, body: CreateReviewBody) => {
  if (actor.impersonating) {
    throw fail(StatusCodes.FORBIDDEN, "Read-only view: changes are not allowed while viewing as this user.", "IMPERSONATION_READ_ONLY");
  }
  const b = await prisma.homeBooking.findFirst({
    where: { id, customerId: actor.userId },
    select: {
      id: true,
      code: true,
      status: true,
      completedAt: true,
      salonId: true,
      expertId: true,
      review: { select: { id: true } },
      salon: { select: { name: true } },
      customer: { select: { name: true } },
      expert: { select: { staff: { select: { user: { select: { name: true } } } } } },
    },
  });
  if (!b) throw new ApiError(StatusCodes.NOT_FOUND, "Booking not found");
  if (b.status !== HomeBookingStatus.COMPLETED || !b.completedAt) {
    throw fail(StatusCodes.CONFLICT, "You can review a visit once it's complete.", "INVALID_STATE");
  }
  if (b.review) throw alreadyReviewed();
  if (Date.now() - b.completedAt.getTime() > REVIEW_WINDOW_MS) {
    throw fail(StatusCodes.CONFLICT, "Reviews are open for 14 days after the visit.", "INVALID_STATE");
  }

  const comment = body.comment?.trim() || null;
  let review;
  try {
    review = await prisma.$transaction(async (tx) => {
      const r = await tx.review.create({
        data: {
          homeBookingId: b.id,
          homeExpertId: b.expertId,
          customerId: actor.userId,
          salonId: b.salonId,
          rating: body.rating,
          comment,
        },
        select: { id: true, rating: true, comment: true, status: true, createdAt: true },
      });
      await recomputeSalonRating(tx, b.salonId);
      await recomputeHomeExpertRating(tx, b.expertId);
      return r;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw alreadyReviewed();
    throw e;
  }

  const stars = "★".repeat(review.rating);
  void notifyBranch(b.salonId, "review.new", {
    title: `${stars} home visit review for ${b.expert.staff.user.name}`,
    body: `${b.customer.name || "A customer"} (${b.code}): ${comment ? `"${comment.slice(0, 160)}"` : `rated ${review.rating}/5`}`,
    link: "/dashboard/reviews",
    dedupeKey: `review.new:${review.id}`,
  });
  return review;
};

/** An expert's PUBLISHED home reviews, newest first: first name only, no reviewer id. */
export const listExpertReviews = async (expertId: string, page = 1) => {
  const p = Math.max(1, Math.min(1_000, page));
  const where: Prisma.ReviewWhereInput = { homeExpertId: expertId, status: ReviewStatus.PUBLISHED };
  const [total, rows] = await Promise.all([
    prisma.review.count({ where }),
    prisma.review.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (p - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        rating: true,
        comment: true,
        createdAt: true,
        ownerReply: true,
        ownerRepliedAt: true,
        customer: { select: { name: true, profilePhoto: true } },
        homeBooking: { select: { items: { select: { nameSnapshot: true } } } },
      },
    }),
  ]);
  return {
    meta: { page: p, limit: PAGE_SIZE, total, totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)) },
    items: rows.map(({ customer, homeBooking, ...r }) => ({
      ...r,
      customer: { name: (customer.name ?? "").trim().split(/\s+/)[0] || "Customer", photo: customer.profilePhoto },
      services: homeBooking?.items.map((i) => i.nameSnapshot) ?? [],
    })),
  };
};
