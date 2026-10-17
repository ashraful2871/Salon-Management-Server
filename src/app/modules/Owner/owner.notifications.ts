import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import ApiError from "../../Error/error";
import catchAsync from "../../shared/catchAsync";
import prisma from "../../shared/prisma";
import sendResponse from "../../shared/sendResponse";
import {
  BOOKING_EMAIL_MODES,
  effectivePrefs,
  EVENT_INFO,
  isNotifyEvent,
  NOTIFY_EVENTS,
} from "../../utils/notify";

/**
 * Owner Phase 13: the bell and its preferences. Every business account sees
 * only its own rows (userId = caller); there is nothing to scope by branch.
 */

const PAGE = 20;
const MAX_PAGE = 50;

const ok = (res: Response, message: string, data: unknown) =>
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message, data });

/** "<createdAt ISO>_<id>" of the last row on the page. */
const parseCursor = (raw: unknown) => {
  if (typeof raw !== "string" || !raw) return null;
  const [at, id] = raw.split("_");
  const date = new Date(at);
  if (!id || Number.isNaN(date.getTime())) throw new ApiError(StatusCodes.BAD_REQUEST, "Invalid cursor");
  return { date, id };
};

/** GET /owner/notifications?cursor&limit&unread=1 */
const list = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const limit = Math.min(Math.max(Number(req.query.limit) || PAGE, 1), MAX_PAGE);
  const cursor = parseCursor(req.query.cursor);
  const unreadOnly = req.query.unread === "1" || req.query.unread === "true";

  const [rows, unread] = await Promise.all([
    prisma.notification.findMany({
      where: {
        userId,
        shown: true,
        ...(unreadOnly && { readAt: null }),
        ...(cursor && {
          OR: [{ createdAt: { lt: cursor.date } }, { createdAt: cursor.date, id: { lt: cursor.id } }],
        }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: { id: true, type: true, title: true, body: true, link: true, salonId: true, readAt: true, createdAt: true },
    }),
    prisma.notification.count({ where: { userId, shown: true, readAt: null } }),
  ]);
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  ok(res, "Notifications", {
    items,
    unread,
    nextCursor: rows.length > limit && last ? `${last.createdAt.toISOString()}_${last.id}` : null,
  });
});

export const markReadBody = z.union([
  z.object({ all: z.literal(true) }).strict(),
  z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }).strict(),
]);

/** PATCH /owner/notifications/read { ids } | { all: true } */
const markRead = catchAsync(async (req: Request, res: Response) => {
  const body = req.body as z.infer<typeof markReadBody>;
  const { count } = await prisma.notification.updateMany({
    where: { userId: req.user!.userId, readAt: null, ...("ids" in body && { id: { in: body.ids } }) },
    data: { readAt: new Date() },
  });
  const unread = await prisma.notification.count({ where: { userId: req.user!.userId, shown: true, readAt: null } });
  ok(res, "Marked as read", { updated: count, unread });
});

/** Events this account can receive: money and business events reach owners only. */
const eventsFor = (role: string) =>
  NOTIFY_EVENTS.filter((e) => role === "SALON_OWNER" || !EVENT_INFO[e].ownerOnly);

const prefsView = async (userId: string, role: string) => {
  const [rows, owner] = await Promise.all([
    prisma.notificationPref.findMany({ where: { userId } }),
    role === "SALON_OWNER"
      ? prisma.salonOwner.findUnique({ where: { userId }, select: { bookingEmailMode: true } })
      : Promise.resolve(null),
  ]);
  const byEvent = new Map(rows.map((r) => [r.event, r]));
  return {
    events: eventsFor(role).map((event) => {
      const info = EVENT_INFO[event];
      return {
        event,
        label: info.label,
        group: info.group,
        ...effectivePrefs(event, byEvent.get(event)),
        emailLocked: !!info.emailLocked,
        // An owner's new-booking emails follow bookingEmailMode instead.
        emailByMode: event === "booking.new" && !!owner,
      };
    }),
    bookingEmailMode: owner?.bookingEmailMode ?? null,
  };
};

/** GET /owner/notification-prefs */
const getPrefs = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Notification preferences", await prefsView(req.user!.userId, req.user!.role));
});

export const prefsBody = z
  .object({
    prefs: z
      .array(z.object({ event: z.string(), email: z.boolean(), inApp: z.boolean() }).strict())
      .min(1)
      .max(NOTIFY_EVENTS.length),
  })
  .strict();

/** PUT /owner/notification-prefs { prefs: [{ event, email, inApp }] } */
const putPrefs = catchAsync(async (req: Request, res: Response) => {
  const { userId, role } = req.user!;
  const allowed = new Set<string>(eventsFor(role));
  const { prefs } = req.body as z.infer<typeof prefsBody>;
  for (const p of prefs) {
    if (!isNotifyEvent(p.event) || !allowed.has(p.event)) {
      throw new ApiError(StatusCodes.BAD_REQUEST, `Unknown event: ${p.event}`);
    }
  }
  await prisma.$transaction(
    prefs.map((p) =>
      prisma.notificationPref.upsert({
        where: { userId_event: { userId, event: p.event } },
        create: { userId, event: p.event, email: p.email, inApp: p.inApp },
        update: { email: p.email, inApp: p.inApp },
      }),
    ),
  );
  ok(res, "Preferences saved", await prefsView(userId, role));
});

export const bookingEmailModeBody = z.object({ mode: z.enum(BOOKING_EMAIL_MODES) }).strict();

/** PATCH /owner/booking-email-mode { mode: EVERY | DIGEST | NONE } (owner only) */
const setBookingEmailMode = catchAsync(async (req: Request, res: Response) => {
  const { mode } = req.body as z.infer<typeof bookingEmailModeBody>;
  const { count } = await prisma.salonOwner.updateMany({
    where: { userId: req.user!.userId },
    data: { bookingEmailMode: mode },
  });
  if (count === 0) throw new ApiError(StatusCodes.NOT_FOUND, "Business not found");
  ok(res, "Booking emails updated", { bookingEmailMode: mode });
});

export const OwnerNotifications = { list, markRead, getPrefs, putPrefs, setBookingEmailMode };
