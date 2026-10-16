import { Prisma } from "@prisma/client";
import config from "../../config";
import prisma from "../shared/prisma";
import { sendEmail } from "./emailSender";

/**
 * Owner Phase 13: one way to tell a business account something happened -
 * an in-app row (the bell) and/or an email, each per the person's
 * preferences. Every owner-facing event goes through `notify`; templates stay
 * in emailTemplates.ts and are passed in.
 */

export const NOTIFY_EVENTS = [
  "booking.new",
  "booking.cancelled",
  "booking.no_show",
  "appeal.filed",
  "review.new",
  "review.hidden",
  "payout.created",
  "payout.paid",
  "payout.failed",
  "dues.reminder",
  "dues.pause_warning",
  "dues.paused",
  "dues.resumed",
  "payout_account.changed",
  "payout_account.verified",
  "payout_account.rejected",
  "team.joined",
  "team.removed",
  "salon.status",
] as const;

export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export const isNotifyEvent = (v: unknown): v is NotifyEvent =>
  typeof v === "string" && (NOTIFY_EVENTS as readonly string[]).includes(v);

type EventInfo = {
  label: string;
  group: "Bookings" | "Reviews" | "Money" | "Business";
  email: boolean;
  inApp: boolean;
  /** Money, payout-account and business events reach the owner only. */
  ownerOnly: boolean;
  /** Security/money notices whose email cannot be switched off. */
  emailLocked?: boolean;
};

/** Defaults for anyone who has not changed a preference. */
export const EVENT_INFO: Record<NotifyEvent, EventInfo> = {
  // booking.new email for an owner is decided by SalonOwner.bookingEmailMode.
  "booking.new": { label: "New booking", group: "Bookings", email: false, inApp: true, ownerOnly: false },
  "booking.cancelled": { label: "Booking cancelled by the customer", group: "Bookings", email: false, inApp: true, ownerOnly: false },
  "booking.no_show": { label: "No-show recorded", group: "Bookings", email: false, inApp: true, ownerOnly: false },
  "appeal.filed": { label: "Customer appealed a no-show", group: "Bookings", email: true, inApp: true, ownerOnly: false },
  "review.new": { label: "New review", group: "Reviews", email: false, inApp: true, ownerOnly: false },
  "review.hidden": { label: "Review hidden by moderators", group: "Reviews", email: true, inApp: true, ownerOnly: false },
  "payout.created": { label: "Payout being prepared", group: "Money", email: true, inApp: true, ownerOnly: true },
  "payout.paid": { label: "Payout sent", group: "Money", email: true, inApp: true, ownerOnly: true },
  "payout.failed": { label: "Payout failed", group: "Money", email: true, inApp: true, ownerOnly: true, emailLocked: true },
  "dues.reminder": { label: "Dues reminder", group: "Money", email: true, inApp: true, ownerOnly: true },
  "dues.pause_warning": { label: "Bookings will pause for dues", group: "Money", email: true, inApp: true, ownerOnly: true, emailLocked: true },
  "dues.paused": { label: "Bookings paused for dues", group: "Money", email: true, inApp: true, ownerOnly: true, emailLocked: true },
  "dues.resumed": { label: "Bookings resumed", group: "Money", email: true, inApp: true, ownerOnly: true },
  "payout_account.changed": { label: "Payout account added", group: "Money", email: true, inApp: true, ownerOnly: true, emailLocked: true },
  "payout_account.verified": { label: "Payout account verified", group: "Money", email: true, inApp: true, ownerOnly: true },
  "payout_account.rejected": { label: "Payout account rejected", group: "Money", email: true, inApp: true, ownerOnly: true },
  "team.joined": { label: "Someone joined your team", group: "Business", email: true, inApp: true, ownerOnly: true },
  "team.removed": { label: "Someone left your team", group: "Business", email: false, inApp: true, ownerOnly: true },
  "salon.status": { label: "Branch approved, suspended or reactivated", group: "Business", email: true, inApp: true, ownerOnly: true },
};

export const BOOKING_EMAIL_MODES = ["EVERY", "DIGEST", "NONE"] as const;
export type BookingEmailMode = (typeof BOOKING_EMAIL_MODES)[number];

export type NotifyPayload = {
  title: string;
  body: string;
  /** Path on the frontend, e.g. "/dashboard/appointments?…". */
  link?: string | null;
  salonId?: string | null;
  /** "<event>:<entityId>": a retry of the same event notifies nobody twice. */
  dedupeKey?: string | null;
  /** html may depend on the recipient's name (templates greet by name). */
  email?: { subject: string; html: string | ((name: string) => string) };
};

/** Effective channels for one user and event, defaults filled in. */
export const effectivePrefs = (
  event: NotifyEvent,
  pref: { email: boolean; inApp: boolean } | undefined,
) => {
  const info = EVENT_INFO[event];
  return {
    inApp: pref?.inApp ?? info.inApp,
    email: info.emailLocked ? true : (pref?.email ?? info.email),
  };
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** For events with no template of their own: title, body and an Open link. */
const plainEmail = (name: string, payload: NotifyPayload) => {
  const link = payload.link ? `${config.frontend_url}${payload.link}` : `${config.frontend_url}/dashboard`;
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222">
  <p>Hi ${escapeHtml(name)},</p>
  <h2 style="font-size:18px;margin:16px 0 8px">${escapeHtml(payload.title)}</h2>
  <p style="line-height:1.5">${escapeHtml(payload.body)}</p>
  <p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#222;color:#fff;text-decoration:none">Open SalonKhuji</a></p>
  <p style="font-size:12px;color:#777">You can change which emails you get in Settings → Notifications.</p>
</div>`;
};

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/**
 * Notifies each user per their preferences. Never throws: a notification must
 * never fail the booking, payout or review it reports. Returns how many rows
 * were shown and emails sent.
 */
export const notify = async (
  userIds: (string | null | undefined)[],
  event: NotifyEvent,
  payload: NotifyPayload,
): Promise<{ inApp: number; emailed: number }> => {
  const done = { inApp: 0, emailed: 0 };
  try {
    const ids = [...new Set(userIds.filter((id): id is string => !!id))];
    if (ids.length === 0) return done;

    const [prefs, users, owners] = await Promise.all([
      prisma.notificationPref.findMany({ where: { userId: { in: ids }, event } }),
      prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } }),
      event === "booking.new"
        ? prisma.salonOwner.findMany({ where: { userId: { in: ids } }, select: { userId: true, bookingEmailMode: true } })
        : Promise.resolve([] as { userId: string; bookingEmailMode: string }[]),
    ]);
    const prefOf = new Map(prefs.map((p) => [p.userId, p]));
    const modeOf = new Map(owners.map((o) => [o.userId, o.bookingEmailMode]));

    for (const user of users) {
      const channels = effectivePrefs(event, prefOf.get(user.id));
      // An owner's booking emails follow the booking email mode (DIGEST goes
      // out from owner.digest); members follow their own preference.
      if (event === "booking.new" && modeOf.has(user.id)) channels.email = modeOf.get(user.id) === "EVERY";
      const wantEmail = channels.email;
      if (!channels.inApp && !wantEmail) continue;

      // A row is written when it shows, or to hold the dedupe key so a retry
      // does not email twice.
      if (channels.inApp || payload.dedupeKey) {
        try {
          await prisma.notification.create({
            data: {
              userId: user.id,
              type: event,
              title: payload.title.slice(0, 200),
              body: payload.body.slice(0, 1000),
              link: payload.link ?? null,
              salonId: payload.salonId ?? null,
              dedupeKey: payload.dedupeKey ?? null,
              shown: channels.inApp,
              readAt: channels.inApp ? null : new Date(),
            },
          });
          if (channels.inApp) done.inApp += 1;
        } catch (err) {
          if (isUniqueViolation(err)) continue; // already notified
          throw err;
        }
      }

      if (wantEmail) {
        const name = user.name || "there";
        const html = !payload.email
          ? plainEmail(name, payload)
          : typeof payload.email.html === "function"
            ? payload.email.html(name)
            : payload.email.html;
        const sent = await sendEmail(user.email, payload.email?.subject ?? payload.title, html);
        if (sent.ok) done.emailed += 1;
      }
    }
  } catch (err) {
    console.error(`[notify] ${event} failed`, err);
  }
  return done;
};

// ------------------------------------------------------------ recipients

/** The owner's user id for a branch (deleted branches too: money still flows). */
export const ownerUserIdOfSalon = async (salonId: string) =>
  (
    await prisma.salon.findUnique({
      where: { id: salonId },
      select: { owner: { select: { userId: true } } },
    })
  )?.owner.userId ?? null;

export const ownerUserIdOf = async (ownerId: string) =>
  (await prisma.salonOwner.findUnique({ where: { id: ownerId }, select: { userId: true } }))?.userId ?? null;

/**
 * Who hears about bookings and reviews at a branch: the owner, plus ACTIVE
 * managers/receptionists who kept `notifyNewBookings` on. A stylist only hears
 * about bookings assigned to them (pass `staffId`) and never about reviews -
 * they cannot see other people's bookings in the app either.
 */
export const branchRecipients = async (salonId: string, opts: { staffId?: string | null; reviews?: boolean } = {}) => {
  const salon = await prisma.salon.findUnique({
    where: { id: salonId },
    select: {
      isDeleted: true,
      owner: { select: { userId: true } },
      members: {
        where: { status: "ACTIVE", notifyNewBookings: true },
        select: { userId: true, role: true },
      },
    },
  });
  if (!salon) return [];
  if (salon.isDeleted) return [salon.owner.userId];

  let stylistUserId: string | null = null;
  if (opts.staffId && !opts.reviews) {
    stylistUserId =
      (await prisma.staff.findUnique({ where: { id: opts.staffId }, select: { userId: true } }))?.userId ?? null;
  }
  const members = salon.members
    .filter((m) => (m.role === "STYLIST" ? m.userId === stylistUserId : true))
    .map((m) => m.userId);
  return [salon.owner.userId, ...members];
};

/** booking/review events: the branch's people, per `branchRecipients`. */
export const notifyBranch = async (
  salonId: string,
  event: NotifyEvent,
  payload: NotifyPayload,
  opts: { staffId?: string | null } = {},
) => {
  try {
    const ids = await branchRecipients(salonId, { ...opts, reviews: event.startsWith("review.") });
    return await notify(ids, event, { salonId, ...payload });
  } catch (err) {
    console.error(`[notify] ${event} recipients failed`, err);
    return { inApp: 0, emailed: 0 };
  }
};

/** Money and business events: the owner (SalonOwner.id) only. */
export const notifyOwner = async (ownerId: string, event: NotifyEvent, payload: NotifyPayload) => {
  try {
    return await notify([await ownerUserIdOf(ownerId)], event, payload);
  } catch (err) {
    console.error(`[notify] ${event} owner lookup failed`, err);
    return { inApp: 0, emailed: 0 };
  }
};
