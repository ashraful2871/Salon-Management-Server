import { JobRunStatus, Prisma } from "@prisma/client";
import config from "../../../../config";
import prisma from "../../../shared/prisma";
import type { JobDef } from "../../../jobs/scheduler";
import { audit, systemAuditCtx } from "../../../utils/audit";
import { sendEmail } from "../../../utils/emailSender";
import { getAdminDigestTemplate, getSystemAlertTemplate } from "../../../utils/emailTemplates";
import { formatBDT } from "../../../utils/money";
import { getSetting } from "../../../utils/settings";
import { indexCoverage } from "../../AI-Suggestion/ai.indexer";
import { addDays, dateOnly, dhakaDay } from "../../Analytics/analytics.days";
import { SettlementService } from "../../Settlement/settlement.service";
import { AdminService } from "../admin.service";
import { permissionsFor } from "../admin.permissions";

/**
 * The jobs behind System health: retention for `job_runs` and `audit_logs`,
 * `system.watch` (checks → `alert_states`, edge-triggered emails) and the
 * morning digest. Registered in src/app/jobs/scheduler.ts.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const JOB_RUNS_KEEP_DAYS = 14;
/** One email per alert key at most this often (a flapping check stays quiet). */
const RENOTIFY_MS = 6 * HOUR;
const AI_COVERAGE_MIN = 0.95;
const APPEAL_DEADLINE_MS = 48 * HOUR;
const APPEAL_DUE_WITHIN_MS = 6 * HOUR;
const STUCK_PAYMENT_MS = HOUR;
const DIGEST_KEY = "digest.lastSent";
const DIGEST_HOUR_DHAKA = 8;

const processStartedAt = Date.now();

// ---------------------------------------------------------------- retention

/** Job `jobruns.retention`, daily: run history older than 14 days. */
export const purgeJobRuns = async () => {
  const { count } = await prisma.jobRun.deleteMany({
    where: { startedAt: { lt: new Date(Date.now() - JOB_RUNS_KEEP_DAYS * DAY) } },
  });
  return { deleted: count, keepDays: JOB_RUNS_KEEP_DAYS };
};

/**
 * Job `audit.retention`, daily. The audit trigger refuses every DELETE unless
 * the transaction set `app.audit_purge`; SET LOCAL ends with the transaction,
 * so nothing else can ride on it.
 */
export const purgeAuditLog = async () => {
  const days = await getSetting("audit.retentionDays");
  const cutoff = new Date(Date.now() - days * DAY);
  const { count } = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL app.audit_purge = 'on'`;
    return tx.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  });
  if (count) {
    console.log(`[jobs] audit.retention: deleted ${count} audit row(s) older than ${days} days`);
    await audit(systemAuditCtx("job"), {
      action: "audit.purge",
      entityType: "system",
      entityId: "audit_logs",
      after: { deleted: count, olderThan: cutoff, retentionDays: days },
    });
  }
  return { deleted: count, retentionDays: days };
};

// ---------------------------------------------------------------- storage

/** `pg_database_size` against the plan's cap (both settings). */
export const databaseStorage = async () => {
  const [[row], capBytes, warnPercent] = await Promise.all([
    prisma.$queryRaw<Array<{ bytes: bigint }>>`
      SELECT pg_database_size(current_database())::bigint AS bytes`,
    getSetting("system.storageCapBytes"),
    getSetting("system.storageWarnPercent"),
  ]);
  const usedBytes = Number(row.bytes);
  return {
    usedBytes,
    capBytes,
    warnPercent,
    percent: capBytes > 0 ? Math.round((usedBytes / capBytes) * 1000) / 10 : 0,
  };
};

const mb = (bytes: number) => `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;

// ---------------------------------------------------------------- checks

const ALERT_LABELS: Record<string, string> = {
  "wallet.drift": "Wallet balances drift from the ledger",
  "ledger.unbalanced": "Unbalanced ledger",
  "payments.stuck": "Payments stuck in PENDING",
  "payouts.failed": "Failed payouts",
  "storage.cap": "Database storage",
  "ai.coverage": "AI search index coverage",
  "appeals.due": "Appeals due soon",
};

export const alertLabel = (key: string) =>
  ALERT_LABELS[key] ?? (key.startsWith("job.") ? `Job ${key.slice(4)}` : key);

type Check = { key: string; firing: boolean; message: string; data?: Record<string, unknown> };

/** Latest finished run (OK/FAILED) per job, and the latest run of any kind. */
export const lastRunsByJob = async () => {
  const [finished, seen] = await Promise.all([
    prisma.$queryRaw<
      Array<{ job: string; status: JobRunStatus; startedAt: Date; durationMs: number | null; error: string | null }>
    >`
      SELECT DISTINCT ON (job) job, status, "startedAt", "durationMs", error
      FROM job_runs WHERE status IN ('OK', 'FAILED')
      ORDER BY job, "startedAt" DESC`,
    prisma.jobRun.groupBy({ by: ["job"], _max: { startedAt: true } }),
  ]);
  return {
    finished: new Map(finished.map((r) => [r.job, r])),
    lastSeen: new Map(seen.map((r) => [r.job, r._max.startedAt])),
  };
};

const jobChecks = async (jobs: JobDef[]): Promise<Check[]> => {
  const { finished, lastSeen } = await lastRunsByJob();
  const now = Date.now();
  return jobs
    .filter((job) => job.name !== "system.watch")
    .map((job) => {
      const last = finished.get(job.name);
      const seenAt = lastSeen.get(job.name)?.getTime() ?? processStartedAt;
      if (last?.status === JobRunStatus.FAILED) {
        return {
          key: `job.${job.name}`,
          firing: true,
          message: `Last run failed: ${(last.error ?? "unknown error").slice(0, 200)}`,
          data: { lastRunAt: last.startedAt },
        };
      }
      if (now - seenAt > 3 * job.everyMs) {
        return {
          key: `job.${job.name}`,
          firing: true,
          message: `Has not run since ${new Date(seenAt).toISOString()} (expected every ${Math.round(job.everyMs / MINUTE)} min)`,
          data: { lastRunAt: new Date(seenAt) },
        };
      }
      return { key: `job.${job.name}`, firing: false, message: "Running on schedule" };
    });
};

const CHECKS: Array<() => Promise<Check | Check[]>> = [
  async () => {
    const run = await prisma.jobRun.findFirst({
      where: { job: "wallet.audit", status: JobRunStatus.OK },
      orderBy: { startedAt: "desc" },
      select: { summary: true, startedAt: true },
    });
    const drifted = Number((run?.summary as { drifted?: number } | null)?.drifted ?? 0);
    return {
      key: "wallet.drift",
      firing: drifted > 0,
      message: `${drifted} wallet(s) differ from their ledger (audit at ${run?.startedAt.toISOString() ?? "never"})`,
      data: { drifted },
    };
  },
  async () => {
    const rows = await SettlementService.findUnbalancedAppointments();
    return {
      key: "ledger.unbalanced",
      firing: rows.length > 0,
      message: `${rows.length} booking(s) whose ledger entries do not sum to zero`,
      data: { count: rows.length },
    };
  },
  async () => {
    const count = await prisma.paymentIntent.count({
      where: { status: "PENDING", createdAt: { lt: new Date(Date.now() - STUCK_PAYMENT_MS) } },
    });
    return { key: "payments.stuck", firing: count > 0, message: `${count} payment(s) PENDING for over an hour`, data: { count } };
  },
  async () => {
    const count = await prisma.payout.count({ where: { status: "FAILED" } });
    return { key: "payouts.failed", firing: count > 0, message: `${count} payout(s) FAILED`, data: { count } };
  },
  async () => {
    const s = await databaseStorage();
    return {
      key: "storage.cap",
      firing: s.percent >= s.warnPercent,
      message: `${mb(s.usedBytes)} of ${mb(s.capBytes)} used (${s.percent}%, warning at ${s.warnPercent}%)`,
      data: { usedBytes: s.usedBytes, capBytes: s.capBytes, percent: s.percent },
    };
  },
  async () => {
    const c = await indexCoverage();
    const share = c.activeSalons > 0 ? c.upToDate / c.activeSalons : 1;
    return {
      key: "ai.coverage",
      firing: share < AI_COVERAGE_MIN,
      message: `${c.upToDate} of ${c.activeSalons} active salons indexed and up to date (${Math.round(share * 1000) / 10}%)`,
      data: { upToDate: c.upToDate, activeSalons: c.activeSalons, stale: c.stale, missing: c.missing },
    };
  },
  async () => {
    // Due within 6 h = filed more than 42 h ago (the deadline is 48 h).
    const count = await prisma.appointment.count({
      where: {
        appealStatus: "PENDING",
        appealedAt: { lt: new Date(Date.now() - (APPEAL_DEADLINE_MS - APPEAL_DUE_WITHIN_MS)) },
      },
    });
    return { key: "appeals.due", firing: count > 0, message: `${count} appeal(s) due within 6 hours or overdue`, data: { count } };
  },
];

/** Admins who asked for alert emails and may see System health. */
const alertRecipients = async () => {
  const admins = await prisma.admin.findMany({
    where: { alertEmails: true, user: { role: "ADMIN", isDeleted: false, status: "ACTIVE" } },
    select: { adminRole: true, user: { select: { email: true } } },
  });
  return admins
    .filter((a) => permissionsFor("ADMIN", a.adminRole).includes("system.view"))
    .map((a) => a.user.email);
};

type StateDetail = { message?: string; notified?: boolean } & Record<string, unknown>;

/**
 * Job `system.watch`, every 15 min. Runs every check, stores each result in
 * `alert_states`, and emails on the edges only: OK → FIRING and, when that
 * firing was announced, FIRING → OK. A key that starts firing again within
 * 6 h of its last alert email stays quiet (and so does its recovery).
 */
export const runSystemWatch = async (jobs: JobDef[]) => {
  const settled = await Promise.allSettled([...CHECKS.map((check) => check()), jobChecks(jobs)]);
  const checks: Check[] = [];
  const errors: string[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") checks.push(...([] as Check[]).concat(r.value));
    else errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
  }
  if (errors.length) console.error(`[jobs] system.watch: ${errors.length} check(s) failed`, errors);

  const now = new Date();
  const previous = new Map(
    (await prisma.alertState.findMany({ where: { key: { in: checks.map((c) => c.key) } } })).map((s) => [s.key, s]),
  );
  const firing: Array<{ label: string; detail: string }> = [];
  const resolved: Array<{ label: string; detail: string }> = [];

  for (const check of checks) {
    const prev = previous.get(check.key);
    const prevDetail = (prev?.detail ?? {}) as StateDetail;
    const wasFiring = prev?.status === "FIRING";
    const quiet = !!prev?.lastNotifiedAt && now.getTime() - prev.lastNotifiedAt.getTime() < RENOTIFY_MS;
    const detail = { ...check.data, message: check.message };

    if (check.firing) {
      // A new episode, or one that started inside the quiet window and has
      // now outlasted it.
      const notify = wasFiring ? !prevDetail.notified && !quiet : !quiet;
      if (notify) firing.push({ label: alertLabel(check.key), detail: check.message });
      const data = {
        status: "FIRING",
        detail: { ...detail, notified: notify || (wasFiring && !!prevDetail.notified) } as Prisma.InputJsonValue,
        ...(wasFiring ? {} : { since: now }),
        ...(notify ? { lastNotifiedAt: now } : {}),
      };
      await prisma.alertState.upsert({
        where: { key: check.key },
        create: { key: check.key, ...data, since: now },
        update: data,
      });
    } else if (wasFiring) {
      if (prevDetail.notified) resolved.push({ label: alertLabel(check.key), detail: check.message });
      await prisma.alertState.update({
        where: { key: check.key },
        data: { status: "OK", since: now, detail: { ...detail, notified: false } as Prisma.InputJsonValue },
      });
    } else if (prev) {
      await prisma.alertState.update({
        where: { key: check.key },
        data: { detail: { ...detail, notified: false } as Prisma.InputJsonValue },
      });
    }
  }

  let emailed = 0;
  if (firing.length || resolved.length) {
    const to = await alertRecipients();
    const subject = firing.length
      ? `[Alert] ${firing.map((f) => f.label).join(", ")}`
      : `[Resolved] ${resolved.map((r) => r.label).join(", ")}`;
    const html = getSystemAlertTemplate({
      firing,
      resolved,
      url: `${config.frontend_url}/dashboard/admin/system`,
    });
    const results = await Promise.all(to.map((email) => sendEmail(email, subject.slice(0, 180), html)));
    emailed = results.filter((r) => r.ok).length;
    console.log(
      `[jobs] system.watch: alert email (${firing.length} firing, ${resolved.length} resolved) to ${emailed}/${to.length} admin(s)`,
    );
  }

  return {
    checked: checks.length,
    firing: checks.filter((c) => c.firing).map((c) => c.key),
    newlyFiring: firing.length,
    resolved: resolved.length,
    emailed,
    failedChecks: errors.length,
  };
};

// ---------------------------------------------------------------- digest

const DIGEST_KPIS: Array<{ id: string; label: string; money?: boolean }> = [
  { id: "bookings.created", label: "Bookings made" },
  { id: "bookings.completed", label: "Bookings completed" },
  { id: "bookings.cancelled", label: "Bookings cancelled" },
  { id: "gmv.completedMinor", label: "GMV (completed)", money: true },
  { id: "commission.minor", label: "Commission", money: true },
  { id: "customers.new", label: "New customers" },
  { id: "signups", label: "Sign-ups" },
];

const INBOX_LABELS: Record<string, string> = {
  "salons.pending": "Salons waiting for approval",
  "applications.pending": "Owner applications",
  "appeals.pending": "No-show appeals",
  "topups.unknown_refund": "Refunds with unknown result",
  "intents.stuck_pending": "Payments stuck in PENDING",
  "payouts.failed": "Failed payouts",
  "payouts.stale_pending": "Payouts pending for long",
  "ledger.unbalanced": "Unbalanced ledger",
  "wallets.drift": "Wallet drift",
  "approvals.pending": "Approvals waiting",
  "support.unanswered": "Unanswered support tickets",
  "reviews.reported": "Reported reviews",
  "jobs.failed": "Failing background jobs",
  "storage.cap": "Database storage",
  "ai.coverage": "AI index coverage",
};

const dhakaHour = (at = new Date()) => new Date(at.getTime() + 6 * HOUR).getUTCHours();
const dhakaTime = (at: Date) =>
  new Date(at.getTime() + 6 * HOUR).toISOString().slice(0, 16).replace("T", " ");

/**
 * Job `admin.digest`, hourly: sends once per Dhaka day, on the first run after
 * 08:00. The day is claimed in `alert_states` before sending, so a crash
 * mid-send loses that day's digest rather than sending it twice.
 */
export const runAdminDigest = async () => {
  const today = dhakaDay();
  if (dhakaHour() < DIGEST_HOUR_DHAKA) return { sent: false, reason: "before 08:00 Dhaka" };
  const state = await prisma.alertState.findUnique({ where: { key: DIGEST_KEY } });
  if ((state?.detail as { day?: string } | null)?.day === today) return { sent: false, reason: "already sent today" };

  await prisma.alertState.upsert({
    where: { key: DIGEST_KEY },
    create: { key: DIGEST_KEY, status: "OK", detail: { day: today } },
    update: { detail: { day: today }, lastNotifiedAt: new Date() },
  });

  const yesterday = addDays(today, -1);
  const [metrics, inbox, alerts, to] = await Promise.all([
    prisma.metricDaily.findMany({
      where: { day: dateOnly(yesterday), metric: { in: DIGEST_KPIS.map((k) => k.id) }, dimension: { in: ["", "*"] } },
      select: { metric: true, dimension: true, value: true },
    }),
    // Everything a SUPER_ADMIN would see in the bell.
    AdminService.inbox({
      userId: "",
      accountRole: "ADMIN",
      adminRole: "SUPER_ADMIN",
      permissions: permissionsFor("ADMIN", "SUPER_ADMIN"),
      mfaEnabled: true,
    }),
    prisma.alertState.findMany({ where: { status: "FIRING" }, orderBy: { since: "asc" } }),
    alertRecipients(),
  ]);

  const value = (id: string, dimension: string) =>
    metrics.find((m) => m.metric === id && m.dimension === dimension)?.value;
  const show = (v: number | undefined, money?: boolean) =>
    v === undefined ? "-" : money ? formatBDT(Math.round(v)) : String(Math.round(v));
  const kpis = DIGEST_KPIS.map((k) => {
    const real = value(k.id, "");
    const all = value(k.id, "*");
    return {
      label: k.label,
      value: all !== undefined && all !== real ? `${show(real, k.money)} (with test data ${show(all, k.money)})` : show(real, k.money),
    };
  });

  const html = getAdminDigestTemplate({
    day: yesterday,
    kpis,
    inbox: inbox.map((i) => ({ label: INBOX_LABELS[i.key] ?? i.key, count: i.count })),
    alerts: alerts.map((a) => ({ label: alertLabel(a.key), since: dhakaTime(a.since) })),
    url: `${config.frontend_url}/dashboard/admin`,
  });
  const results = await Promise.all(to.map((email) => sendEmail(email, `Daily digest - ${yesterday}`, html)));
  const sent = results.filter((r) => r.ok).length;
  console.log(`[jobs] admin.digest: ${yesterday} sent to ${sent}/${to.length} admin(s)`);
  return { sent: true, day: yesterday, recipients: to.length, delivered: sent, alerts: alerts.length, inbox: inbox.length };
};
