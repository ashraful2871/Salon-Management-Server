import { HomeBookingStatus } from "@prisma/client";
import prisma from "../../shared/prisma";
import { deleteExpertDocs } from "./home.expertSetup";
import { notifyHomeBooking } from "./home.notify";

/**
 * Home Service timer jobs (registered in jobs/scheduler.ts). Each move is a
 * conditional update, so a run racing a payment or a second instance only
 * ever moves a booking once.
 */

/** `home.expire`: unpaid bookings past their payment window → EXPIRED, freeing the time. */
export const expireUnpaidHomeBookings = async () => {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE home_bookings SET status = 'EXPIRED', "updatedAt" = now()
    WHERE status = 'PENDING_PAYMENT' AND "expiresAt" < now()
    RETURNING id`;
  if (rows.length) {
    await prisma.homeBookingEvent.createMany({
      data: rows.map((r) => ({
        bookingId: r.id,
        fromStatus: HomeBookingStatus.PENDING_PAYMENT,
        toStatus: HomeBookingStatus.EXPIRED,
        actorRole: "SYSTEM",
        reason: "Not paid in time",
      })),
    });
  }
  return { expired: rows.length };
};

// home.stale (IN_PROGRESS long past its end → COMPLETED + settled) and
// home.notArrived (EXPERT_LATE_FLAG) live with the visit lifecycle.
export { closeStaleVisits, flagLateExperts } from "./home.lifecycle";

// ---------------------------------------------------------------------------
// home.reminders (every 5 min)
// ---------------------------------------------------------------------------

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

const REMINDERS = [
  { field: "reminder24At", when: "24h", aheadMs: 24 * HOUR_MS },
  { field: "reminder2hAt", when: "2h", aheadMs: 2 * HOUR_MS },
] as const;

/**
 * CONFIRMED visits whose start is within 24 h (then 2 h) and whose stamp is
 * null. The stamp is claimed with a conditional `updateMany` before anything
 * is sent, so two instances (or a rerun) never send twice; the cost is that a
 * send which fails is not retried (`sendEmail` never throws and logs it).
 * A reschedule clears both stamps.
 *
 * Stamped without sending: a 24 h reminder for a visit booked inside those
 * 24 h (the confirmation just said it all) or when the 2 h one is already due,
 * and a 2 h reminder with under 30 minutes left (the expert is on the way).
 * A 2 h reminder for a visit confirmed in the last 30 minutes waits a run.
 */
export const sendHomeReminders = async (now = new Date()) => {
  let sent = 0;
  let silent = 0;
  for (const r of REMINDERS) {
    const rows = await prisma.homeBooking.findMany({
      where: {
        status: HomeBookingStatus.CONFIRMED,
        startAt: { gt: now, lte: new Date(now.getTime() + r.aheadMs) },
        [r.field]: null,
      },
      select: { id: true, startAt: true, confirmedAt: true },
      orderBy: { startAt: "asc" },
      take: 200,
    });
    for (const b of rows) {
      const untilMs = b.startAt.getTime() - now.getTime();
      const confirmedMs = (b.confirmedAt ?? now).getTime();
      let quiet: boolean;
      if (r.when === "24h") {
        quiet = untilMs <= 2 * HOUR_MS || confirmedMs > b.startAt.getTime() - r.aheadMs;
      } else {
        if (confirmedMs > now.getTime() - 30 * MIN_MS) continue;
        quiet = untilMs < 30 * MIN_MS;
      }
      // The claim. Losing it means another run already did this one.
      const { count } = await prisma.homeBooking.updateMany({
        where: { id: b.id, status: HomeBookingStatus.CONFIRMED, [r.field]: null },
        data: { [r.field]: now },
      });
      if (!count) continue;
      if (quiet) {
        silent++;
        continue;
      }
      await notifyHomeBooking(b.id, { kind: "reminder", when: r.when });
      sent++;
    }
  }
  if (sent) console.log(`[jobs] home.reminders: sent ${sent}`);
  return { sent, silent };
};

// ---------------------------------------------------------------------------
// home.retention (daily)
// ---------------------------------------------------------------------------

const ADDRESS_KEEP_MS = 180 * DAY_MS;
const EXPERT_DOCS_KEEP_MS = 90 * DAY_MS;
const BLOCK_KEEP_MS = 30 * DAY_MS;

/**
 * Personal data kept only as long as it is needed:
 * - visits ended (COMPLETED / CANCELLED / NO_SHOW, and EXPIRED, which never
 *   happened at all) more than 180 days ago lose the street address (the area
 *   stays), landmark, notes and contact phone; the pin is rounded to 2
 *   decimals (~1 km). `contactPhone = ''` marks a scrubbed row.
 * - removed experts' ID documents go 90 days after removal (Cloudinary first;
 *   the ids are forgotten only once the delete went through).
 * - customer blocks that ended more than 30 days ago are deleted.
 */
export const runHomeRetention = async (now = new Date()) => {
  const addressCutoff = new Date(now.getTime() - ADDRESS_KEEP_MS);
  const addressesScrubbed = await prisma.$executeRaw`
    UPDATE home_bookings
    SET "addressLine" = COALESCE(NULLIF(btrim(area), ''), 'removed'),
        landmark = NULL,
        notes = NULL,
        "contactPhone" = '',
        latitude = round(latitude::numeric, 2)::double precision,
        longitude = round(longitude::numeric, 2)::double precision,
        "updatedAt" = now()
    WHERE status IN ('COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED')
      AND COALESCE("completedAt", "cancelledAt", "noShowMarkedAt", "startAt") < ${addressCutoff}
      AND "contactPhone" <> ''`;

  const experts = await prisma.homeExpert.findMany({
    where: {
      removedAt: { lt: new Date(now.getTime() - EXPERT_DOCS_KEEP_MS) },
      OR: [{ idDocFrontId: { not: null } }, { idDocBackId: { not: null } }, { selfieId: { not: null } }],
    },
    select: { id: true, idDocFrontId: true, idDocBackId: true, selfieId: true },
    take: 100,
  });
  let expertDocsDeleted = 0;
  for (const e of experts) {
    const ids = [e.idDocFrontId, e.idDocBackId, e.selfieId].filter((x): x is string => !!x);
    if (!(await deleteExpertDocs(ids))) continue;
    const { count } = await prisma.homeExpert.updateMany({
      where: { id: e.id, removedAt: { not: null } },
      data: { idDocFrontId: null, idDocBackId: null, selfieId: null },
    });
    expertDocsDeleted += count;
  }

  const { count: blocksDeleted } = await prisma.homeCustomerBlock.deleteMany({
    where: { until: { lt: new Date(now.getTime() - BLOCK_KEEP_MS) } },
  });

  return { addressesScrubbed, expertDocsDeleted, blocksDeleted };
};
