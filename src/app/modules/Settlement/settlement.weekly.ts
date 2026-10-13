import config from "../../../config";
import prisma from "../../shared/prisma";
import { systemAuditCtx } from "../../utils/audit";
import { sendEmail } from "../../utils/emailSender";
import { getPayoutBatchSummaryTemplate, getPayoutPreparedTemplate } from "../../utils/emailTemplates";
import { formatBDT } from "../../utils/money";
import { getSetting } from "../../utils/settings";
import { permissionsFor } from "../Admin/admin.permissions";
import { addDays, dayStart, dhakaDay } from "../Analytics/analytics.days";
import { destinationLabel, SettlementService } from "./settlement.service";

const HOUR = 60 * 60 * 1000;
const RUN_HOUR_DHAKA = 9;
/** `alert_states` row holding the ISO week (its Monday) the job last ran for. */
const WEEK_KEY = "payouts.weekly.lastWeek";

const dhakaClock = (at: Date) => new Date(at.getTime() + 6 * HOUR);

const weekdayName = (day: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(
    new Date(`${day}T00:00:00Z`),
  );

/** Every active admin whose role holds finance.payouts. */
const financeRecipients = async () => {
  const admins = await prisma.admin.findMany({
    where: { user: { role: "ADMIN", isDeleted: false, status: "ACTIVE" } },
    select: { adminRole: true, user: { select: { email: true } } },
  });
  return admins
    .filter((a) => permissionsFor("ADMIN", a.adminRole).includes("finance.payouts"))
    .map((a) => a.user.email);
};

/** "Being prepared" to each business that got a payout. Never throws. */
const emailOwners = async (payoutIds: string[], expectedBy: string) => {
  if (payoutIds.length === 0) return 0;
  const payouts = await prisma.payout.findMany({
    where: { id: { in: payoutIds } },
    select: {
      netMinor: true,
      destinationSnapshot: true,
      owner: { select: { user: { select: { name: true, email: true } } } },
    },
  });
  const results = await Promise.all(
    payouts.map((p) =>
      p.owner.user.email
        ? sendEmail(
            p.owner.user.email,
            `Payout of ${formatBDT(p.netMinor)} is being prepared`,
            getPayoutPreparedTemplate({
              ownerName: p.owner.user.name,
              amount: formatBDT(p.netMinor),
              destination: destinationLabel(p.destinationSnapshot),
              expectedBy,
            }),
          )
        : Promise.resolve({ ok: false }),
    ),
  );
  return results.filter((r) => r.ok).length;
};

/**
 * Job `payouts.weekly`, hourly. Acts on the first run at or after 09:00 Asia/Dhaka
 * on `payouts.weekday`, once per ISO week: skipped when the week is already
 * marked in `alert_states`, or when a first-attempt payout was raised since
 * this Monday 00:00 Dhaka (an admin ran the batch by hand). The week is marked
 * before the batch runs, so a crash mid-run means Finance runs it by hand
 * rather than the job raising a second batch.
 */
export const runWeeklyPayouts = async (now = new Date()) => {
  const clock = dhakaClock(now);
  const weekday = await getSetting("payouts.weekday");
  if (clock.getUTCDay() !== weekday) return { ran: false, reason: "not the payout day" };
  if (clock.getUTCHours() < RUN_HOUR_DHAKA) return { ran: false, reason: "before 09:00 Dhaka" };

  const today = dhakaDay(now);
  const monday = addDays(today, -((clock.getUTCDay() + 6) % 7));
  const periodEnd = dayStart(monday);

  const state = await prisma.alertState.findUnique({ where: { key: WEEK_KEY } });
  if ((state?.detail as { week?: string } | null)?.week === monday) {
    return { ran: false, reason: "already ran this week", week: monday };
  }

  const claim = () =>
    prisma.alertState.upsert({
      where: { key: WEEK_KEY },
      create: { key: WEEK_KEY, status: "OK", detail: { week: monday } },
      update: { detail: { week: monday }, lastNotifiedAt: new Date() },
    });

  const existing = await prisma.payout.count({ where: { createdAt: { gte: periodEnd }, attempt: 1 } });
  if (existing > 0) {
    await claim();
    return { ran: false, reason: "a batch was already raised this week", week: monday, existing };
  }
  await claim();

  const result = await SettlementService.runPayoutBatch(
    { periodEnd },
    { ctx: systemAuditCtx("job"), reason: `Weekly payouts, week of ${monday}` },
  );

  const totalMinor = result.created.reduce((sum, p) => sum + p.netMinor, 0);
  const skippedBy = new Map<string, number>();
  for (const s of result.skipped) skippedBy.set(s.reason, (skippedBy.get(s.reason) ?? 0) + 1);
  const skipped = [...skippedBy].map(([reason, count]) => ({ reason, count }));

  const ownersEmailed = await emailOwners(
    result.created.map((p) => p.payoutId),
    weekdayName(addDays(today, 1)),
  ).catch((error) => {
    console.error("[payouts.weekly] owner emails failed", error);
    return 0;
  });

  let financeEmailed = 0;
  try {
    const to = await financeRecipients();
    const html = getPayoutBatchSummaryTemplate({
      week: monday,
      count: result.created.length,
      total: formatBDT(totalMinor),
      skipped,
      url: `${config.frontend_url}/dashboard/admin/finance/payouts`,
    });
    const sent = await Promise.all(
      to.map((email) => sendEmail(email, `Weekly payouts: ${result.created.length} raised (${formatBDT(totalMinor)})`, html)),
    );
    financeEmailed = sent.filter((r) => r.ok).length;
  } catch (error) {
    console.error("[payouts.weekly] finance summary failed", error);
  }

  console.log(
    `[payouts.weekly] week ${monday}: ${result.created.length} payout(s), ${formatBDT(totalMinor)}, ${result.skipped.length} skipped`,
  );
  return {
    ran: true,
    week: monday,
    created: result.created.length,
    totalMinor,
    skipped,
    ownersEmailed,
    financeEmailed,
  };
};
