import { PaymentIntentService } from "../modules/Payment/paymentIntent.service";
import { AppointmentCheckout } from "../modules/Appointment/appointment.checkout";
import { AppointmentDeposit } from "../modules/Appointment/appointment.deposit";
import { WalletService } from "../modules/Wallet/wallet.service";
import { syncSearchIndex } from "../modules/AI-Suggestion/ai.indexer";
import { sendBookingReminders } from "../modules/Assistant/assistant.reminders";
import { purgeExpiredConversations } from "../modules/Assistant/assistant.service";
import {
  purgeHairTryOn,
  sweepHairTryOnTag,
} from "../modules/HairTryOn/hairTryOn.cleanup";
import { AdminUsersService } from "../modules/Admin/users/users.service";
import { AdminApprovalsService } from "../modules/Admin/approvals/approvals.service";
import { AdminSupportService } from "../modules/Admin/support/support.service";
import {
  rollupBeforeTryOnPurge,
  runAnalyticsRetention,
  runAnalyticsRollup,
} from "../modules/Analytics/analytics.rollup";
import {
  purgeAuditLog,
  purgeJobRuns,
  runAdminDigest,
  runSystemWatch,
} from "../modules/Admin/system/system.jobs";
import prisma from "../shared/prisma";
import { JobRunStatus, Prisma } from "@prisma/client";
import { releaseJobLock, tryJobLock } from "./jobLock";

/**
 * Periodic money work, the AI search index repair, retention, and the health
 * checks behind the admin System page. Every run is recorded in `job_runs`.
 *
 * Every job here is idempotent - top-ups are keyed by transaction id, deposit
 * outcomes by appointment id - so if this process is running on more than one
 * instance, the duplicate run is harmless rather than a double charge. Set
 * DISABLE_BACKGROUND_JOBS=true to turn them off (for a worker split, or in a
 * local process you do not want reaching the gateway).
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const RECONCILE_INTERVAL_MS = HOUR;
const NO_SHOW_INTERVAL_MS = 10 * MINUTE;
const STALE_CHECKOUT_INTERVAL_MS = 30 * MINUTE;
const WALLET_AUDIT_INTERVAL_MS = 6 * HOUR;
const AI_INDEX_INTERVAL_MS = 10 * MINUTE;
// Not hourly: the 2-hour reminder's window is 30 minutes wide, and an hourly
// run would step straight over half the bookings. Running more often is free
// of risk — each reminder is claimed by its stamp, so it still sends once.
const REMINDER_INTERVAL_MS = 15 * MINUTE;
const RETENTION_INTERVAL_MS = 24 * HOUR;
const AUTH_CLEANUP_INTERVAL_MS = 24 * HOUR;
const AUTH_CODE_KEEP_MS = 7 * 24 * HOUR;
// Try-on photos expire 24 h after upload; a 30-minute run keeps "deleted
// within 24 hours" true with at most half an hour of slack.
const HAIR_CLEANUP_INTERVAL_MS = 30 * MINUTE;
const HAIR_SWEEP_INTERVAL_MS = 24 * HOUR;
const USERS_UNSUSPEND_INTERVAL_MS = HOUR;
const SYSTEM_WATCH_INTERVAL_MS = 15 * MINUTE;

export type JobTrigger = "timer" | "warmup" | "manual";

export type JobDef = {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
  /** May an admin start it from the System page ("Run now")? */
  safeToRunNow: boolean;
};

export type JobOutcome = {
  status: "OK" | "FAILED" | "SKIPPED";
  runId: string | null;
  durationMs: number;
  summary: Prisma.InputJsonValue | null;
  error: string | null;
};

const SUMMARY_MAX_CHARS = 4000;
const ERROR_MAX_CHARS = 1000;

/** What a job returned, as JSON for `job_runs.summary`; big lists are dropped. */
const toSummary = (value: unknown): Prisma.InputJsonValue | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") return { result: value as Prisma.InputJsonValue };
  const json = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  if (JSON.stringify(json).length <= SUMMARY_MAX_CHARS) return json as Prisma.InputJsonValue;
  const scalars = Object.fromEntries(
    Object.entries(json).filter(([, v]) => v === null || typeof v !== "object"),
  );
  return { ...scalars, truncated: true } as Prisma.InputJsonValue;
};

const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MAX_CHARS);

/** Jobs running in this process: the cheap first guard before the DB lock. */
const running = new Set<string>();

const skipped = async (name: string, trigger: JobTrigger): Promise<JobOutcome> => {
  const row = await prisma.jobRun
    .create({
      data: {
        job: name,
        trigger,
        status: JobRunStatus.SKIPPED,
        finishedAt: new Date(),
        durationMs: 0,
        summary: { reason: "already running" },
      },
      select: { id: true },
    })
    .catch(() => null);
  return { status: "SKIPPED", runId: row?.id ?? null, durationMs: 0, summary: null, error: null };
};

/**
 * Runs one job and records it in `job_runs`. Never throws: a job that fails
 * must not take the server down with it.
 *
 * 1. an advisory lock on the job's name (another instance, or a "Run now",
 *    already holding it → a SKIPPED row, nothing runs);
 * 2. a RUNNING row; 3. the job; 4. OK/FAILED with the duration, the job's own
 *    counts as `summary` and the error message; 5. unlock.
 *
 * If the lock connection itself is down the job still runs: the money jobs are
 * idempotent, and stopping all of them because of a lock is the worse outage.
 */
export const runJob = async (
  name: string,
  run: () => Promise<unknown>,
  trigger: JobTrigger = "timer",
): Promise<JobOutcome> => {
  if (running.has(name)) return skipped(name, trigger);
  running.add(name);

  let locked = false;
  const started = Date.now();
  try {
    try {
      locked = await tryJobLock(name);
      if (!locked) return await skipped(name, trigger);
    } catch (error) {
      console.error(`[jobs] ${name}: lock unavailable, running without it`, error);
    }

    const row = await prisma.jobRun
      .create({ data: { job: name, trigger, status: JobRunStatus.RUNNING }, select: { id: true } })
      .catch((error) => {
        console.error(`[jobs] ${name}: could not record the run`, error);
        return null;
      });

    let outcome: JobOutcome;
    try {
      const result = await run();
      outcome = {
        status: "OK",
        runId: row?.id ?? null,
        durationMs: Date.now() - started,
        summary: toSummary(result),
        error: null,
      };
    } catch (error) {
      console.error(`[jobs] ${name} failed`, error);
      outcome = {
        status: "FAILED",
        runId: row?.id ?? null,
        durationMs: Date.now() - started,
        summary: null,
        error: errorText(error),
      };
    }

    if (row) {
      await prisma.jobRun
        .update({
          where: { id: row.id },
          data: {
            status: outcome.status === "OK" ? JobRunStatus.OK : JobRunStatus.FAILED,
            finishedAt: new Date(),
            durationMs: outcome.durationMs,
            summary: outcome.summary ?? undefined,
            error: outcome.error,
          },
        })
        .catch((error) => console.error(`[jobs] ${name}: could not finish the run row`, error));
    }
    return outcome;
  } catch (error) {
    console.error(`[jobs] ${name} failed`, error);
    return { status: "FAILED", runId: null, durationMs: Date.now() - started, summary: null, error: errorText(error) };
  } finally {
    if (locked) {
      await releaseJobLock(name).catch((error) => console.error(`[jobs] ${name}: unlock failed`, error));
    }
    running.delete(name);
  }
};

/** Chat retention is a promise in the privacy notice: guests 30 days after
 *  their last turn, signed-in customers 90. The count, and nothing else. */
const purgeConversations = async () => {
  const deleted = await purgeExpiredConversations();
  console.log(`[jobs] assistant.retention: deleted ${deleted} expired conversation(s)`);
  return { deleted };
};

/** Sign-up/email-change codes and reset links are dead long before a week;
 *  the rows only matter to the throttle, which looks back a day. Counts only. */
const purgeAuthCodes = async () => {
  const cutoff = new Date(Date.now() - AUTH_CODE_KEEP_MS);

  const [otps, tokens] = await Promise.all([
    prisma.otpChallenge.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.verificationToken.deleteMany({
      where: { OR: [{ usedAt: { lt: cutoff } }, { expiresAt: { lt: cutoff } }] },
    }),
  ]);

  console.log(
    `[jobs] auth.cleanup: deleted ${otps.count} code(s) and ${tokens.count} link token(s)`,
  );
  return { codes: otps.count, tokens: tokens.count };
};

const auditWallets = async () => {
  const drifted = await WalletService.findDrift();

  if (drifted.length) {
    console.error(
      `[jobs] wallet.audit: ${drifted.length} wallet(s) no longer match their ledger`,
      drifted,
    );
  }
  // system.watch reads `drifted` from this run's summary (alert wallet.drift).
  return { drifted: drifted.length };
};

/**
 * Every timer job. `safeToRunNow` marks the ones an admin may start by hand:
 * idempotent reads and repairs. Bookings changing state (no-shows, stale
 * check-outs), customer emails (reminders) and deletions (the purges) only
 * ever run on their timer.
 */
export const JOBS: JobDef[] = [
  { name: "payment.reconcile", everyMs: RECONCILE_INTERVAL_MS, safeToRunNow: true, run: () => PaymentIntentService.reconcilePendingIntents() },
  // Arrival is an explicit check-in at the counter, so nothing starts a booking
  // on the clock. Bookings nobody checked in become no-shows; ones that were
  // checked in but never completed are closed as completed instead.
  { name: "deposit.autoNoShow", everyMs: NO_SHOW_INTERVAL_MS, safeToRunNow: false, run: () => AppointmentDeposit.autoMarkNoShows() },
  { name: "appointment.autoCloseStale", everyMs: STALE_CHECKOUT_INTERVAL_MS, safeToRunNow: false, run: () => AppointmentCheckout.autoCloseStaleCheckIns() },
  { name: "wallet.audit", everyMs: WALLET_AUDIT_INTERVAL_MS, safeToRunNow: true, run: auditWallets },
  // Embeds salons that are new, changed, or were missed when Gemini was down.
  // Writes re-embed straight away; this is the net under them.
  { name: "ai.syncIndex", everyMs: AI_INDEX_INTERVAL_MS, safeToRunNow: true, run: () => syncSearchIndex() },
  // 24 h and 2 h email reminders for CONFIRMED bookings, once each.
  { name: "assistant.reminders", everyMs: REMINDER_INTERVAL_MS, safeToRunNow: false, run: () => sendBookingReminders() },
  { name: "assistant.retention", everyMs: RETENTION_INTERVAL_MS, safeToRunNow: false, run: purgeConversations },
  { name: "auth.cleanup", everyMs: AUTH_CLEANUP_INTERVAL_MS, safeToRunNow: false, run: purgeAuthCodes },
  // Expired try-on photos and results, then a daily sweep of the Cloudinary
  // tag for anything the database lost track of.
  { name: "hair.cleanup", everyMs: HAIR_CLEANUP_INTERVAL_MS, safeToRunNow: false, run: () => purgeHairTryOn(rollupBeforeTryOnPurge) },
  { name: "hair.sweep", everyMs: HAIR_SWEEP_INTERVAL_MS, safeToRunNow: false, run: sweepHairTryOnTag },
  // Timed account suspensions that have run out.
  { name: "users.unsuspend", everyMs: USERS_UNSUSPEND_INTERVAL_MS, safeToRunNow: true, run: async () => ({ reactivated: await AdminUsersService.unsuspendExpired() }) },
  // Four-eyes requests nobody decided within 24 h.
  { name: "approvals.expire", everyMs: HOUR, safeToRunNow: true, run: AdminApprovalsService.expireStale },
  // Tickets RESOLVED more than 7 days ago → CLOSED.
  { name: "support.autoclose", everyMs: 24 * HOUR, safeToRunNow: false, run: AdminSupportService.autoClose },
  // Daily metrics for D-1…D-3 (+ yesterday's closing balances once a day),
  // then the raw daily tables trimmed after their metrics are rolled up.
  { name: "analytics.rollup", everyMs: HOUR, safeToRunNow: true, run: runAnalyticsRollup },
  { name: "analytics.retention", everyMs: 24 * HOUR, safeToRunNow: false, run: runAnalyticsRetention },
  // This table's own retention, the audit log's, the health checks behind the
  // alert emails, and the morning digest.
  { name: "jobruns.retention", everyMs: 24 * HOUR, safeToRunNow: false, run: purgeJobRuns },
  { name: "audit.retention", everyMs: 24 * HOUR, safeToRunNow: false, run: purgeAuditLog },
  { name: "system.watch", everyMs: SYSTEM_WATCH_INTERVAL_MS, safeToRunNow: false, run: () => runSystemWatch(JOBS) },
  { name: "admin.digest", everyMs: HOUR, safeToRunNow: false, run: runAdminDigest },
];

export const findJob = (name: string) => JOBS.find((job) => job.name === name);

/** When this process started each timer, for the "next run" estimate. */
const timerStartedAt = new Map<string, number>();

/** The next tick of this process's timer for `job`, or null if none runs here. */
export const nextRunApprox = (job: JobDef): Date | null => {
  const start = timerStartedAt.get(job.name);
  if (start === undefined) return null;
  const ticks = Math.floor((Date.now() - start) / job.everyMs) + 1;
  return new Date(start + ticks * job.everyMs);
};

const every = (job: JobDef) => {
  timerStartedAt.set(job.name, Date.now());
  const timer = setInterval(() => void runJob(job.name, job.run), job.everyMs);
  // Do not hold the event loop open just for a timer.
  timer.unref?.();
  return timer;
};

const warmup = (delayMs: number, run: () => Promise<unknown>) => {
  const timer = setTimeout(() => void run(), delayMs);
  timer.unref?.();
};

/** Runs a job after boot unless it already ran within its interval. */
const runIfDue = async (job: JobDef) => {
  const last = await prisma.jobRun
    .findFirst({
      where: { job: job.name, status: { in: [JobRunStatus.OK, JobRunStatus.FAILED] } },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    })
    .catch(() => null);
  if (last && Date.now() - last.startedAt.getTime() < job.everyMs) return;
  await runJob(job.name, job.run, "warmup");
};

export const startBackgroundJobs = () => {
  if (process.env.DISABLE_BACKGROUND_JOBS === "true") {
    console.log("[jobs] background jobs disabled");
    return;
  }

  for (const job of JOBS) every(job);

  // Catch anything that got stuck while the process was down, but not in the
  // first seconds of boot - a restart loop should not hammer the gateway.
  const reconcile = findJob("payment.reconcile")!;
  warmup(2 * MINUTE, () => runJob(reconcile.name, reconcile.run, "warmup"));

  // Sooner than the payment warm-up: a salon missing from the index is
  // invisible to every AI search until this runs.
  const aiSync = findJob("ai.syncIndex")!;
  warmup(45 * 1000, () => runJob(aiSync.name, aiSync.run, "warmup"));

  // An hourly or daily timer restarts with every deploy, and restarts can come
  // more often than the interval — without a run after boot the job might never
  // happen (and system.watch would call it stale). Only the ones not run within
  // their interval, one after another.
  warmup(5 * MINUTE, async () => {
    const due = JOBS.filter((j) => j.everyMs >= HOUR && j !== reconcile && j !== aiSync);
    for (const job of due) {
      await runIfDue(job);
    }
  });

  console.log("[jobs] background jobs started");
};
