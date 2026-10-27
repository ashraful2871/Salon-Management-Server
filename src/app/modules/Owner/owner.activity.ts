import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import catchAsync from "../../shared/catchAsync";
import prisma from "../../shared/prisma";
import { formatBDT } from "../../utils/money";
import sendResponse from "../../shared/sendResponse";
import { scopeSalonIds, withAccessCache } from "../../utils/salonAccess";
import { addDays, dayStart, isDay } from "../Analytics/analytics.days";

import { SITE_NAME } from "../../utils/brand";
/**
 * GET /owner/activity - who did what at the caller's branches, from the audit
 * log (owner Phase 13). Scope is `activity.view`: an owner sees every branch,
 * a manager their own. Only the business's own actions (and the platform's
 * automatic ones) on an allow-list are shown; admin and agent actions never
 * are, and neither are the before/after snapshots - a row carries a plain
 * sentence and a link, nothing a customer would not want a receptionist to read.
 */

/** Action → what the row says after the actor's name. */
const ACTIONS: Record<string, string> = {
  "booking.check_in": "checked in a customer",
  "booking.start": "started a service",
  "booking.checkout": "completed a booking and recorded payment",
  "booking.status_change": "changed a booking's status",
  "booking.cancel": "cancelled a booking",
  "booking.walk_in": "added a walk-in",
  "booking.discount": "gave a discount at checkout",
  "close.submit": "closed the day at the till",
  "close.reopen": "reopened a closed day",
  "appointment.reschedule": "moved a booking",
  "customer.note": "updated a customer note",
  "review.reply": "replied to a review",
  "review.reply_edit": "edited a review reply",
  "services.copy": "copied services between branches",
  "services.price_change": "changed a service price",
  "salon.update": "edited branch details",
  "salon.location": "moved the map pin",
  "salon.hours_copy": "copied opening hours",
  "salon.closure_create": "added a closure",
  "salon.closure_delete": "removed a closure",
  "salon.pause": "paused online bookings",
  "salon.resume": "resumed online bookings",
  "dues.pause": "paused online bookings for unpaid dues",
  "dues.resume": "resumed online bookings after dues were paid",
  "staff.shifts_update": "changed a stylist's working hours",
  "staff.time_off_create": "added time off",
  "staff.time_off_delete": "removed time off",
  "team.invite": "invited someone to the team",
  "team.invite_resend": "resent an invitation",
  "team.invite_revoke": "revoked an invitation",
  "team.accept": "joined the team",
  "team.member_update": "changed a team member's role",
  "team.member_remove": "removed a team member",
  "team.member_leave": "left the team",
};

/** Filter chips: action groups by prefix. */
const GROUPS: Record<string, string[]> = {
  bookings: Object.keys(ACTIONS).filter((a) => a.startsWith("booking.") || a === "appointment.reschedule"),
  customers: ["customer.note", "review.reply", "review.reply_edit"],
  catalogue: Object.keys(ACTIONS).filter((a) => a.startsWith("services.") || a.startsWith("salon.") || a.startsWith("dues.")),
  team: Object.keys(ACTIONS).filter((a) => a.startsWith("team.") || a.startsWith("staff.")),
  close: ["close.submit", "close.reopen", "booking.discount"],
};

const HIDDEN_ROLES = ["ADMIN", "AGENT"];
const PAGE = 30;

/** A few safe after-fields turned into words; never names, phones or notes. */
const detailOf = (action: string, after: Prisma.JsonValue | null) => {
  const a = (after && typeof after === "object" && !Array.isArray(after) ? after : {}) as Record<string, unknown>;
  if (action === "booking.status_change" && typeof a.status === "string") return `to ${a.status.toLowerCase().replace("_", " ")}`;
  if (action === "booking.checkout" && typeof a.paymentMethod === "string") return `by ${a.paymentMethod.toLowerCase()}`;
  if (action === "close.submit" && typeof a.differenceMinor === "number") {
    const d = a.differenceMinor;
    return d === 0 ? "and the till balanced" : `- ${d < 0 ? "short" : "over"} by ${formatBDT(Math.abs(d))}`;
  }
  if (action === "booking.discount" && typeof a.discountMinor === "number") return `of ${formatBDT(a.discountMinor)}`;
  if (action === "team.member_update" && typeof a.role === "string") return `to ${a.role.toLowerCase()}`;
  if (action === "team.accept" && typeof a.branchRole === "string") return `as ${a.branchRole.toLowerCase()}`;
  return null;
};

const parseCursor = (raw: unknown) => {
  if (typeof raw !== "string" || !raw) return null;
  const [at, id] = raw.split("_");
  const date = new Date(at);
  if (!id || Number.isNaN(date.getTime())) throw new ApiError(StatusCodes.BAD_REQUEST, "Invalid cursor");
  return { date, id };
};

const list = catchAsync(async (req: Request, res: Response) => {
  const user = withAccessCache(req);
  const q = req.query;
  const requested = typeof q.salonId === "string" && q.salonId && q.salonId !== "all" ? q.salonId : undefined;
  const scope = (await scopeSalonIds(user, "activity.view", requested)) ?? [];

  for (const day of [q.from, q.to]) {
    if (day !== undefined && day !== "" && !isDay(day)) {
      throw new ApiError(StatusCodes.BAD_REQUEST, "from and to must be days in YYYY-MM-DD format.");
    }
  }
  const group = typeof q.action === "string" && q.action ? q.action : null;
  if (group && !GROUPS[group] && !ACTIONS[group]) throw new ApiError(StatusCodes.BAD_REQUEST, "Unknown action filter");
  const actions = group ? (GROUPS[group] ?? [group]) : Object.keys(ACTIONS);
  const actor = typeof q.actor === "string" && q.actor ? q.actor : null;
  const cursor = parseCursor(q.cursor);

  const empty = { items: [], nextCursor: null, actors: [], groups: Object.keys(GROUPS) };
  if (scope.length === 0) return sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Activity", data: empty });

  const base: Prisma.AuditLogWhereInput = {
    salonId: { in: scope },
    action: { in: actions },
    actorRole: { notIn: HIDDEN_ROLES },
  };
  const where: Prisma.AuditLogWhereInput = {
    ...base,
    ...(actor && { actorUserId: actor }),
    createdAt: {
      ...(typeof q.from === "string" && q.from && { gte: dayStart(q.from) }),
      ...(typeof q.to === "string" && q.to && { lt: dayStart(addDays(q.to, 1)) }),
    },
    ...(cursor && {
      OR: [{ createdAt: { lt: cursor.date } }, { createdAt: cursor.date, id: { lt: cursor.id } }],
    }),
  };

  const [rows, actorRows] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PAGE + 1,
      select: { id: true, createdAt: true, actorUserId: true, actorRole: true, source: true, salonId: true, action: true, entityType: true, entityId: true, after: true },
    }),
    // The "who" filter: everyone who did something here in the last 90 days.
    cursor
      ? Promise.resolve([])
      : prisma.auditLog.groupBy({
          by: ["actorUserId"],
          where: { ...base, actorUserId: { not: null }, createdAt: { gte: new Date(Date.now() - 90 * 86400000) } },
          _count: { _all: true },
          orderBy: { _count: { actorUserId: "desc" } },
          take: 50,
        }),
  ]);
  const page = rows.slice(0, PAGE);

  const userIds = [...new Set([...page.map((r) => r.actorUserId), ...actorRows.map((a) => a.actorUserId)].filter((x): x is string => !!x))];
  const salonIds = [...new Set(page.map((r) => r.salonId).filter((x): x is string => !!x))];
  const bookingIds = page.filter((r) => r.entityType === "booking" && r.entityId).map((r) => r.entityId!);
  const [users, salons, bookings] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
    prisma.salon.findMany({ where: { id: { in: salonIds } }, select: { id: true, name: true } }),
    prisma.appointment.findMany({ where: { id: { in: bookingIds } }, select: { id: true, token: true } }),
  ]);
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  const salonOf = new Map(salons.map((s) => [s.id, s.name]));
  const tokenOf = new Map(bookings.map((b) => [b.id, b.token]));

  const linkOf = (r: (typeof page)[number]) => {
    if (r.entityType === "booking" && r.entityId) {
      const token = tokenOf.get(r.entityId);
      return token ? `/dashboard/appointments?date=all&searchTerm=${token}` : null;
    }
    if (r.entityType === "customer" && r.entityId) return `/dashboard/customers/${r.entityId}`;
    if (r.entityType === "review") return "/dashboard/reviews?show=all";
    if (r.action.startsWith("team.") || r.action.startsWith("staff.")) return "/dashboard/team";
    if (r.action.startsWith("services.")) return "/dashboard/services";
    if (r.salonId) return `/dashboard/store/${r.salonId}`;
    return null;
  };

  const items = page.map((r) => ({
    id: r.id,
    at: r.createdAt,
    actor: r.actorUserId
      ? { id: r.actorUserId, name: nameOf.get(r.actorUserId) ?? "Former team member", role: r.actorRole }
      : { id: null, name: `${SITE_NAME} (automatic)`, role: r.actorRole },
    salon: r.salonId ? { id: r.salonId, name: salonOf.get(r.salonId) ?? "Deleted branch" } : null,
    action: r.action,
    text: ACTIONS[r.action] ?? r.action,
    detail: detailOf(r.action, r.after),
    link: linkOf(r),
  }));
  const last = page[page.length - 1];

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Activity",
    data: {
      items,
      nextCursor: rows.length > PAGE && last ? `${last.createdAt.toISOString()}_${last.id}` : null,
      actors: actorRows.map((a) => ({ id: a.actorUserId!, name: nameOf.get(a.actorUserId!) ?? "Former team member" })),
      groups: Object.keys(GROUPS),
    },
  });
});

export const OwnerActivity = { list };
