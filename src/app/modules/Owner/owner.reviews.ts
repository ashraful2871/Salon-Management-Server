import { Request, Response } from "express";
import { Prisma, ReviewStatus } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import ApiError from "../../Error/error";
import catchAsync from "../../shared/catchAsync";
import prisma from "../../shared/prisma";
import sendResponse from "../../shared/sendResponse";
import { AccessUser, scopeSalonIds, withAccessCache } from "../../utils/salonAccess";

/**
 * GET /owner/reviews?salonId&rating&replied&cursor - every review of the
 * branches in the caller's `reviews.reply` scope, newest first. A HIDDEN
 * review shows its status and reason but never its text. The first page also
 * carries `summary` (PUBLISHED reviews only, like the public rating).
 */

/** How long after posting the business may still edit its reply. */
export const REPLY_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

const listQuery = z.object({
  salonId: z.string().trim().min(1).optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  replied: z.enum(["true", "false"]).optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const parse = <T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> => {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(StatusCodes.BAD_REQUEST, result.error.issues[0]?.message ?? "Invalid query");
  }
  return result.data;
};

const REVIEW_SELECT = {
  id: true,
  rating: true,
  comment: true,
  status: true,
  hiddenReason: true,
  createdAt: true,
  ownerReply: true,
  ownerRepliedAt: true,
  customer: { select: { id: true, name: true, profilePhoto: true } },
  salon: { select: { id: true, name: true } },
  staff: { select: { id: true, user: { select: { name: true } } } },
  appointment: { select: { appointmentDate: true, service: { select: { name: true } } } },
} satisfies Prisma.ReviewSelect;

type ReviewRow = Prisma.ReviewGetPayload<{ select: typeof REVIEW_SELECT }>;

const toItem = (row: ReviewRow, now: number) => {
  const { staff, appointment, ...rest } = row;
  const hidden = row.status === ReviewStatus.HIDDEN;
  return {
    ...rest,
    comment: hidden ? null : row.comment,
    hiddenReason: hidden ? row.hiddenReason : null,
    staff: staff ? { id: staff.id, name: staff.user.name } : null,
    serviceName: appointment.service?.name ?? null,
    visitDate: appointment.appointmentDate,
    canReply: !hidden && !row.ownerReply,
    canEditReply:
      !hidden && !!row.ownerRepliedAt && now - row.ownerRepliedAt.getTime() < REPLY_EDIT_WINDOW_MS,
  };
};

const summaryOf = async (ids: string[]) => {
  const published = { salonId: { in: ids }, status: ReviewStatus.PUBLISHED };
  const [agg, byRating, byStaff, unreplied] = await Promise.all([
    prisma.review.aggregate({ where: published, _avg: { rating: true }, _count: { _all: true } }),
    prisma.review.groupBy({ by: ["rating"], where: published, _count: { _all: true } }),
    prisma.review.groupBy({
      by: ["staffId"],
      where: { ...published, staffId: { not: null } },
      _avg: { rating: true },
      _count: { _all: true },
    }),
    prisma.review.count({ where: { ...published, ownerReply: null } }),
  ]);
  const staffIds = byStaff.map((row) => row.staffId as string);
  const names = staffIds.length
    ? await prisma.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, user: { select: { name: true } } } })
    : [];
  const nameOf = new Map(names.map((s) => [s.id, s.user.name]));

  return {
    average: Math.round((agg._avg.rating ?? 0) * 10) / 10,
    count: agg._count._all,
    unreplied,
    breakdown: [5, 4, 3, 2, 1].map((stars) => ({
      stars,
      count: byRating.find((row) => row.rating === stars)?._count._all ?? 0,
    })),
    staff: byStaff
      .map((row) => ({
        staffId: row.staffId as string,
        name: nameOf.get(row.staffId as string) ?? "Former staff",
        average: Math.round((row._avg.rating ?? 0) * 10) / 10,
        count: row._count._all,
      }))
      .sort((a, b) => b.count - a.count),
  };
};

const listReviews = async (user: AccessUser, query: unknown) => {
  const q = parse(listQuery, query);
  const requested = q.salonId && q.salonId !== "all" ? q.salonId : undefined;
  const ids = (await scopeSalonIds(user, "reviews.reply", requested)) ?? [];
  if (!ids.length) return { items: [], nextCursor: null, summary: null };

  const where: Prisma.ReviewWhereInput = {
    salonId: { in: ids },
    ...(q.rating && { rating: q.rating }),
    // "Unreplied" = something the business can still answer.
    ...(q.replied === "false" && { ownerReply: null, status: ReviewStatus.PUBLISHED }),
    ...(q.replied === "true" && { ownerReply: { not: null } }),
  };

  const [rows, summary] = await Promise.all([
    prisma.review.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
      select: REVIEW_SELECT,
    }),
    q.cursor ? null : summaryOf(ids),
  ]);

  const now = Date.now();
  const page = rows.slice(0, q.limit);
  return {
    items: page.map((row) => toItem(row, now)),
    nextCursor: rows.length > q.limit ? page[page.length - 1].id : null,
    summary,
  };
};

const list = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Reviews",
    data: await listReviews(withAccessCache(req), req.query),
  });
});

export const OwnerReviews = { list };
