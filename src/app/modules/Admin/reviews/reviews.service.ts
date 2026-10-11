import { Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import config from "../../../../config";
import ApiError from "../../../Error/error";
import prisma from "../../../shared/prisma";
import { AuditCtx, auditTx } from "../../../utils/audit";
import { sendEmail } from "../../../utils/emailSender";
import { getReviewHiddenTemplate } from "../../../utils/emailTemplates";
import { recomputeSalonRating, recomputeStaffRating } from "../../Review/review.service";
import { parseListQuery } from "../admin.query";
import { maskEmail } from "../admin.service";
import { REVIEW_REASON_LABELS, ReviewModeration } from "./reviews.validation";

type Query = Record<string, string | undefined>;

/**
 * "Reported" = still up, has reports, and nobody has acted since. Hiding or
 * keeping a review stamps moderatedAt; a new report clears it again.
 */
export const REPORTED_REVIEWS: Prisma.ReviewWhereInput = {
  status: "PUBLISHED",
  reportCount: { gt: 0 },
  moderatedAt: null,
};
const LOW: Prisma.ReviewWhereInput = { status: "PUBLISHED", rating: { lte: 2 } };
const HIDDEN: Prisma.ReviewWhereInput = { status: "HIDDEN" };

const TAB: Record<string, Prisma.ReviewWhereInput> = {
  reported: REPORTED_REVIEWS,
  low: LOW,
  hidden: HIDDEN,
  all: {},
};

const list = async (query: Query) => {
  const tab = query.tab ?? "reported";
  const { skip, take, orderBy, q, page, limit } = parseListQuery(query, {
    sortable: ["createdAt", "rating", "reportCount"],
    defaultSort: tab === "reported" ? { field: "reportCount", order: "desc" } : { field: "createdAt", order: "desc" },
  });

  const base: Prisma.ReviewWhereInput[] = [];
  if (query.includeTest !== "true") base.push({ salon: { isTest: false } });
  if (query.salonId) base.push({ salonId: query.salonId });
  if (query.rating) base.push({ rating: Number(query.rating) });
  if (q) {
    base.push({
      OR: [
        { comment: { contains: q, mode: "insensitive" } },
        { salon: { name: { contains: q, mode: "insensitive" } } },
        { customer: { name: { contains: q, mode: "insensitive" } } },
      ],
    });
  }
  const where: Prisma.ReviewWhereInput = { AND: [...base, TAB[tab] ?? REPORTED_REVIEWS] };
  const countOf = (w: Prisma.ReviewWhereInput) => prisma.review.count({ where: { AND: [...base, w] } });

  const [rows, total, reported, low, hidden] = await Promise.all([
    prisma.review.findMany({
      where,
      skip,
      take,
      orderBy: [orderBy, { createdAt: "desc" }],
      select: {
        id: true,
        rating: true,
        comment: true,
        status: true,
        hiddenReason: true,
        reportCount: true,
        moderatedAt: true,
        createdAt: true,
        salon: { select: { id: true, name: true } },
        customer: { select: { id: true, name: true, email: true } },
        reports: { select: { reason: true, note: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 5 },
      },
    }),
    prisma.review.count({ where }),
    countOf(REPORTED_REVIEWS),
    countOf(LOW),
    countOf(HIDDEN),
  ]);

  return {
    meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)), tabCounts: { reported, low, hidden } },
    data: rows.map(({ customer, ...r }) => ({
      ...r,
      customer: { id: customer.id, name: customer.name, email: maskEmail(customer.email) },
    })),
  };
};

/**
 * Hide or restore a review (PUBLISHED on a published review keeps it and
 * clears it from the Reported queue). Status, moderation fields, the rating
 * recompute and the audit row commit together; the reviewer email follows.
 */
const moderate = async (ctx: AuditCtx | undefined, adminUserId: string, id: string, body: ReviewModeration) => {
  const review = await prisma.review.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      salonId: true,
      staffId: true,
      hiddenReason: true,
      salon: { select: { name: true, rating: true, totalReviews: true } },
      customer: { select: { name: true, email: true } },
    },
  });
  if (!review) throw new ApiError(StatusCodes.NOT_FOUND, "Review not found");
  if (body.status === "HIDDEN" && review.status === "HIDDEN") {
    throw new ApiError(StatusCodes.CONFLICT, "This review is already hidden");
  }

  const hide = body.status === "HIDDEN";

  const result = await prisma.$transaction(async (tx) => {
    const now = new Date();
    await tx.review.update({
      where: { id },
      data: {
        status: body.status,
        hiddenReason: hide ? body.reasonCode : null,
        moderatedById: adminUserId,
        moderatedAt: now,
      },
    });
    const salon = await recomputeSalonRating(tx, review.salonId);
    if (review.staffId) await recomputeStaffRating(tx, review.staffId);

    await auditTx(tx, ctx, {
      action: hide ? "review.hide" : "review.restore",
      entityType: "review",
      entityId: id,
      salonId: review.salonId,
      before: {
        status: review.status,
        hiddenReason: review.hiddenReason,
        salonRating: review.salon.rating,
        salonTotalReviews: review.salon.totalReviews,
      },
      after: {
        status: body.status,
        reasonCode: body.reasonCode,
        notify: hide && body.notify,
        salonRating: salon.rating,
        salonTotalReviews: salon.totalReviews,
      },
      reason: [body.reasonCode, body.note].filter(Boolean).join(": "),
    });

    return { id, status: body.status, moderatedAt: now, salon };
  });

  if (hide && body.notify) {
    // Reason code only: never the moderator's note, never who reported it.
    void sendEmail(
      review.customer.email,
      "Your review has been hidden",
      getReviewHiddenTemplate({
        name: review.customer.name,
        salonName: review.salon.name,
        reason: REVIEW_REASON_LABELS[body.reasonCode] ?? "Other",
        contactUrl: `${config.frontend_url}/contact`,
      }),
    );
  }

  return result;
};

export const AdminReviewsService = { list, moderate };
