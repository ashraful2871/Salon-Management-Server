import { AppointmentStatus } from "@prisma/client";
import config from "../../../config";
import prisma from "../../shared/prisma";
import { sendEmail } from "../../utils/emailSender";
import { addDays, dateOnly, dayStart, dhakaDay } from "../Analytics/analytics.days";

/**
 * Owner Phase 13 jobs: the morning booking digest for owners whose
 * `bookingEmailMode` is DIGEST, and the bell's retention.
 */

const HOUR = 60 * 60 * 1000;
const DIGEST_HOUR_DHAKA = 8;
const DIGEST_KEY = "owner.digest.lastDay";
const RETENTION_DAYS = 90;
const WALK_IN = "@walk-in.invalid";

const dhakaHour = (at = new Date()) => new Date(at.getTime() + 6 * HOUR).getUTCHours();

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

type BranchLine = { name: string; booked: number; cancelled: number; today: number };

const digestHtml = (ownerName: string, day: string, lines: BranchLine[]) => {
  const rows = lines
    .map(
      (l) =>
        `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee">${esc(l.name)}</td>` +
        `<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${l.booked}</td>` +
        `<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${l.cancelled}</td>` +
        `<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${l.today}</td></tr>`,
    )
    .join("");
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#222">
  <p>Hi ${esc(ownerName)},</p>
  <p>Online bookings made on ${day}, per branch:</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px">
    <tr style="text-align:left;color:#666"><th style="padding:6px 8px">Branch</th><th style="padding:6px 8px;text-align:right">New</th><th style="padding:6px 8px;text-align:right">Cancelled</th><th style="padding:6px 8px;text-align:right">On today</th></tr>
    ${rows}
  </table>
  <p><a href="${config.frontend_url}/dashboard/calendar" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#222;color:#fff;text-decoration:none">Open today's calendar</a></p>
  <p style="font-size:12px;color:#777">You get this because booking emails are set to a daily digest. Change it in Settings → Notifications.</p>
</div>`;
};

/**
 * Job `owner.digest`, hourly: from 08:00 Dhaka, once per day, yesterday's
 * online bookings (made, cancelled by the customer) and today's count per
 * branch to every DIGEST owner who had any. The day is marked only after the
 * run, so a failed run retries the next hour (the job lock stops two at once).
 */
export const runOwnerDigest = async (now = new Date()) => {
  const today = dhakaDay(now);
  if (dhakaHour(now) < DIGEST_HOUR_DHAKA) return { sent: 0, reason: "before 08:00 Dhaka" };
  const state = await prisma.alertState.findUnique({ where: { key: DIGEST_KEY } });
  if ((state?.detail as { day?: string } | null)?.day === today) return { sent: 0, reason: "already sent today" };

  const yesterday = addDays(today, -1);
  const from = dayStart(yesterday);
  const to = dayStart(today);
  const digestOwner = { owner: { bookingEmailMode: "DIGEST" }, isDeleted: false };
  const online = { customer: { email: { not: { endsWith: WALK_IN } } } };

  const [booked, cancelled, onToday] = await Promise.all([
    prisma.appointment.groupBy({
      by: ["salonId"],
      where: { createdAt: { gte: from, lt: to }, salon: digestOwner, ...online },
      _count: { _all: true },
    }),
    prisma.appointment.groupBy({
      by: ["salonId"],
      where: { cancelledAt: { gte: from, lt: to }, cancelledBy: "CUSTOMER", salon: digestOwner },
      _count: { _all: true },
    }),
    prisma.appointment.groupBy({
      by: ["salonId"],
      where: { appointmentDate: dateOnly(today), status: { not: AppointmentStatus.CANCELLED }, salon: digestOwner },
      _count: { _all: true },
    }),
  ]);

  // Only branches with something from yesterday; today's count rides along.
  const active = [...new Set([...booked, ...cancelled].map((r) => r.salonId))];
  const count = (rows: { salonId: string; _count: { _all: number } }[]) =>
    new Map(rows.map((r) => [r.salonId, r._count._all]));
  const [b, c, t] = [count(booked), count(cancelled), count(onToday)];

  const salons = await prisma.salon.findMany({
    where: { id: { in: active } },
    select: { id: true, name: true, owner: { select: { id: true, user: { select: { name: true, email: true } } } } },
  });
  const byOwner = new Map<string, { name: string; email: string; lines: BranchLine[] }>();
  for (const s of salons) {
    const entry = byOwner.get(s.owner.id) ?? { name: s.owner.user.name, email: s.owner.user.email, lines: [] };
    entry.lines.push({ name: s.name, booked: b.get(s.id) ?? 0, cancelled: c.get(s.id) ?? 0, today: t.get(s.id) ?? 0 });
    byOwner.set(s.owner.id, entry);
  }

  let sent = 0;
  for (const owner of byOwner.values()) {
    owner.lines.sort((x, y) => y.booked - x.booked || x.name.localeCompare(y.name));
    const lines = owner.lines.slice(0, 50);
    const total = owner.lines.reduce((sum, l) => sum + l.booked, 0);
    const result = await sendEmail(
      owner.email,
      `${total} new booking${total === 1 ? "" : "s"} yesterday`,
      digestHtml(owner.name || "there", yesterday, lines),
    );
    if (result.ok) sent += 1;
  }

  await prisma.alertState.upsert({
    where: { key: DIGEST_KEY },
    create: { key: DIGEST_KEY, status: "OK", detail: { day: today } },
    update: { detail: { day: today }, lastNotifiedAt: new Date() },
  });
  return { owners: byOwner.size, sent };
};

/** Job `notifications.retention`, daily: read bell rows older than 90 days. */
export const purgeReadNotifications = async () => {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * HOUR);
  const { count } = await prisma.notification.deleteMany({
    where: { readAt: { not: null }, createdAt: { lt: cutoff } },
  });
  return { deleted: count };
};
