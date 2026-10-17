import { Request, Response } from "express";
import { PaymentMethod, PaymentStatus, Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import ApiError from "../../Error/error";
import catchAsync from "../../shared/catchAsync";
import prisma from "../../shared/prisma";
import sendResponse from "../../shared/sendResponse";
import { audit } from "../../utils/audit";
import { formatBDT } from "../../utils/money";
import { notifyOwner } from "../../utils/notify";
import {
  AccessUser,
  assertOwnerOf,
  assertSalonPermission,
  scopeSalonIds,
  withAccessCache,
} from "../../utils/salonAccess";
import { buildAuditCtx } from "../Admin/admin.middleware";
import { addDays, dayStart, dhakaDay } from "../Analytics/analytics.days";

/**
 * Daily close (owner Phase 14, `close.manage`): at closing time the desk counts
 * the till against what the system expected for that Dhaka day. One close per
 * branch per day; the owner can reopen a day (DELETE + reason, audited) and the
 * desk submits again.
 *
 * Expected = counter payments (COMPLETED, CASH / CARD / MOBILE_BANKING) whose
 * `paymentDate` falls on that Dhaka day - the bill (`amountMinor`) plus the tip
 * (`tipMinor`), because both are in the till. Wallet deposits never are.
 */

/** |difference| at or above this tells the owner (৳100). */
export const CLOSE_ALERT_MINOR = 10_000;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const parse = <T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> => {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(StatusCodes.BAD_REQUEST, result.error.issues[0]?.message ?? "Invalid query");
  }
  return result.data;
};

const dayQuery = z.object({
  salonId: z.string().trim().min(1, "Choose a branch"),
  date: z.string().regex(DAY, "date must be YYYY-MM-DD").optional(),
});

const historyQuery = z.object({
  salonId: z.string().trim().min(1).optional(),
});

export const submitCloseBody = z.object({
  body: z.object({
    salonId: z.string().trim().min(1, "Choose a branch"),
    date: z.string().regex(DAY, "date must be YYYY-MM-DD"),
    countedCashMinor: z.number().int().min(0).max(1_000_000_000),
    note: z.string().trim().max(500).optional(),
  }),
});

export const reopenCloseBody = z.object({
  body: z.object({ reason: z.string().trim().min(3, "Give a reason").max(300) }),
});

/** The day must be a real date that has started in Dhaka. */
const assertDay = (date: string) => {
  if (Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || addDays(date, 0) !== date) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "date must be YYYY-MM-DD");
  }
  if (date > dhakaDay()) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "You can't close a day that hasn't started");
  }
};

const COUNTER_METHODS: PaymentMethod[] = [
  PaymentMethod.CASH,
  PaymentMethod.CARD,
  PaymentMethod.MOBILE_BANKING,
];

/** What the counter took at `salonId` on Dhaka day `date`, by method (poisha). */
export const expectedForDay = async (
  salonId: string,
  date: string,
  db: Prisma.TransactionClient = prisma,
) => {
  const from = dayStart(date);
  const to = dayStart(addDays(date, 1));
  const groups = await db.payment.groupBy({
    by: ["paymentMethod"],
    where: {
      status: PaymentStatus.COMPLETED,
      paymentMethod: { in: COUNTER_METHODS },
      appointment: { salonId },
      OR: [
        { paymentDate: { gte: from, lt: to } },
        { paymentDate: null, createdAt: { gte: from, lt: to } },
      ],
    },
    _sum: { amountMinor: true, tipMinor: true },
    _count: { _all: true },
  });

  const byMethod = (m: PaymentMethod) => {
    const g = groups.find((row) => row.paymentMethod === m);
    return (g?._sum.amountMinor ?? 0) + (g?._sum.tipMinor ?? 0);
  };

  return {
    cashMinor: byMethod(PaymentMethod.CASH),
    cardMinor: byMethod(PaymentMethod.CARD),
    mobileMinor: byMethod(PaymentMethod.MOBILE_BANKING),
    tipsMinor: groups.reduce((sum, g) => sum + (g._sum.tipMinor ?? 0), 0),
    payments: groups.reduce((sum, g) => sum + g._count._all, 0),
  };
};

const CLOSE_SELECT = {
  id: true,
  salonId: true,
  date: true,
  expectedCashMinor: true,
  countedCashMinor: true,
  cardMinor: true,
  mobileMinor: true,
  differenceMinor: true,
  note: true,
  closedById: true,
  createdAt: true,
  salon: { select: { name: true } },
} satisfies Prisma.DailyCloseSelect;

type CloseRow = Prisma.DailyCloseGetPayload<{ select: typeof CLOSE_SELECT }>;

const toItem = (row: CloseRow, names: Map<string, string | null>) => {
  const { salon, ...rest } = row;
  return {
    ...rest,
    date: row.date.toISOString().slice(0, 10),
    salonName: salon.name,
    closedByName: names.get(row.closedById) ?? null,
  };
};

const closerNames = async (rows: { closedById: string }[]) => {
  const ids = [...new Set(rows.map((r) => r.closedById))];
  const users = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    : [];
  return new Map(users.map((u) => [u.id, u.name]));
};

/** Whether the caller may reopen (owners only; managers and desk submit). */
const canReopen = async (user: AccessUser, salonId: string) => {
  if (user.role !== "SALON_OWNER") return false;
  const { salonIds } = await assertOwnerOf(user).catch(() => ({ salonIds: [] as string[] }));
  return salonIds.includes(salonId);
};

/** GET /owner/daily-close?salonId&date - expected figures + the close, if any. */
const getDay = catchAsync(async (req: Request, res: Response) => {
  const user = withAccessCache(req);
  const q = parse(dayQuery, req.query);
  const date = q.date ?? dhakaDay();
  assertDay(date);
  await assertSalonPermission(user, q.salonId, "close.manage");

  const [expected, row] = await Promise.all([
    expectedForDay(q.salonId, date),
    prisma.dailyClose.findUnique({
      where: { salonId_date: { salonId: q.salonId, date: new Date(`${date}T00:00:00Z`) } },
      select: CLOSE_SELECT,
    }),
  ]);
  const names = row ? await closerNames([row]) : new Map<string, string | null>();

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Daily close",
    data: {
      salonId: q.salonId,
      date,
      expected,
      close: row ? toItem(row, names) : null,
      canReopen: await canReopen(user, q.salonId),
    },
  });
});

/** GET /owner/daily-close/history?salonId - the last 30 closes in scope. */
const history = catchAsync(async (req: Request, res: Response) => {
  const user = withAccessCache(req);
  const q = parse(historyQuery, req.query);
  const requested = q.salonId && q.salonId !== "all" ? q.salonId : undefined;
  const scope = (await scopeSalonIds(user, "close.manage", requested)) ?? [];

  const rows = scope.length
    ? await prisma.dailyClose.findMany({
        where: { salonId: { in: scope } },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        take: 30,
        select: CLOSE_SELECT,
      })
    : [];
  const names = await closerNames(rows);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Daily close history",
    data: { items: rows.map((r) => toItem(r, names)) },
  });
});

/** POST /owner/daily-close - one per branch per Dhaka day (409 after). */
const submit = catchAsync(async (req: Request, res: Response) => {
  const user = withAccessCache(req);
  const body = req.body as z.infer<typeof submitCloseBody>["body"];
  assertDay(body.date);
  await assertSalonPermission(user, body.salonId, "close.manage");

  // The server decides what was expected, at the moment of the count.
  const expected = await expectedForDay(body.salonId, body.date);
  const differenceMinor = body.countedCashMinor - expected.cashMinor;

  let row: CloseRow;
  try {
    row = await prisma.dailyClose.create({
      data: {
        salonId: body.salonId,
        date: new Date(`${body.date}T00:00:00Z`),
        expectedCashMinor: expected.cashMinor,
        countedCashMinor: body.countedCashMinor,
        cardMinor: expected.cardMinor,
        mobileMinor: expected.mobileMinor,
        differenceMinor,
        note: body.note || null,
        closedById: user.userId,
      },
      select: CLOSE_SELECT,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new ApiError(
        StatusCodes.CONFLICT,
        "This day is already closed for this branch. The owner can reopen it.",
      );
    }
    throw err;
  }

  await audit(buildAuditCtx(req, user.role), {
    action: "close.submit",
    entityType: "daily_close",
    entityId: row.id,
    salonId: body.salonId,
    after: {
      date: body.date,
      expectedCashMinor: expected.cashMinor,
      countedCashMinor: body.countedCashMinor,
      differenceMinor,
    },
  });

  if (Math.abs(differenceMinor) >= CLOSE_ALERT_MINOR) {
    const salon = await prisma.salon.findUnique({
      where: { id: body.salonId },
      select: { ownerId: true, name: true },
    });
    if (salon) {
      const word = differenceMinor < 0 ? "short" : "over";
      const amount = formatBDT(Math.abs(differenceMinor));
      const title = `Till ${word} by ${amount} at ${salon.name}`;
      const text = `The ${body.date} close counted ${formatBDT(body.countedCashMinor)} cash against ${formatBDT(expected.cashMinor)} expected.`;
      void notifyOwner(salon.ownerId, "close.difference", {
        title,
        body: text,
        link: `/dashboard/close?salonId=${body.salonId}&date=${body.date}`,
        salonId: body.salonId,
        dedupeKey: `close.difference:${row.id}`,
        email: {
          subject: title,
          html: (name) =>
            `<p>Hi ${name},</p><p>${text}</p>${body.note ? `<p>Note from the desk: ${escapeHtml(body.note)}</p>` : ""}`,
        },
      });
    }
  }

  const names = await closerNames([row]);
  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: "Day closed",
    data: toItem(row, names),
  });
});

/** DELETE /owner/daily-close/:id { reason } - the owner reopens a day. */
const reopen = catchAsync(async (req: Request, res: Response) => {
  const user = withAccessCache(req);
  const { reason } = req.body as z.infer<typeof reopenCloseBody>["body"];
  const { salonIds } = await assertOwnerOf(user);

  const row = await prisma.dailyClose.findUnique({ where: { id: String(req.params.id) } });
  if (!row || !salonIds.includes(row.salonId)) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Close not found");
  }
  await prisma.dailyClose.delete({ where: { id: row.id } });

  await audit(buildAuditCtx(req, user.role), {
    action: "close.reopen",
    entityType: "daily_close",
    entityId: row.id,
    salonId: row.salonId,
    before: {
      date: row.date.toISOString().slice(0, 10),
      expectedCashMinor: row.expectedCashMinor,
      countedCashMinor: row.countedCashMinor,
      differenceMinor: row.differenceMinor,
    },
    reason,
  });

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Day reopened",
    data: { id: row.id },
  });
});

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const OwnerDailyClose = { getDay, history, submit, reopen };
