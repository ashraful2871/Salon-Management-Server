import { JobRunStatus, Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import config from "../../../../config";
import ApiError from "../../../Error/error";
import { findJob, JOBS, nextRunApprox, runJob, type JobOutcome } from "../../../jobs/scheduler";
import prisma from "../../../shared/prisma";
import { audit, AuditCtx } from "../../../utils/audit";
import { emailHealth } from "../../../utils/emailSender";
import { getSetting } from "../../../utils/settings";
import { geminiModelState, isGeminiConfigured } from "../../AI-Suggestion/ai.gemini";
import { databaseStorage } from "./system.jobs";

/** GET /admin/system/*: jobs, integrations and storage for the System page. */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A manual run answers once done, or after this long with "still running". */
const MANUAL_RUN_WAIT_MS = 20 * 1000;

export type HealthLevel = "ok" | "warning" | "down" | "off";

const everyLabel = (ms: number) => (ms % HOUR === 0 ? `${ms / HOUR} h` : `${Math.round(ms / MINUTE)} min`);

// ---------------------------------------------------------------- jobs

const listJobs = async () => {
  const [latest, failures] = await Promise.all([
    prisma.$queryRaw<
      Array<{
        job: string;
        status: JobRunStatus;
        trigger: string;
        startedAt: Date;
        finishedAt: Date | null;
        durationMs: number | null;
        error: string | null;
        summary: Prisma.JsonValue;
      }>
    >`
      SELECT DISTINCT ON (job) job, status, trigger, "startedAt", "finishedAt", "durationMs", error, summary
      FROM job_runs ORDER BY job, "startedAt" DESC`,
    prisma.jobRun.groupBy({
      by: ["job"],
      where: { status: JobRunStatus.FAILED, startedAt: { gte: new Date(Date.now() - DAY) } },
      _count: { _all: true },
    }),
  ]);
  const last = new Map(latest.map((r) => [r.job, r]));
  const failed = new Map(failures.map((f) => [f.job, f._count._all]));

  return {
    enabled: process.env.DISABLE_BACKGROUND_JOBS !== "true",
    jobs: JOBS.map((job) => {
      const run = last.get(job.name);
      return {
        name: job.name,
        every: everyLabel(job.everyMs),
        everyMs: job.everyMs,
        lastRun: run
          ? {
              status: run.status,
              trigger: run.trigger,
              startedAt: run.startedAt,
              finishedAt: run.finishedAt,
              durationMs: run.durationMs,
              error: run.error,
              summary: run.summary,
            }
          : null,
        failures24h: failed.get(job.name) ?? 0,
        nextRunApprox: nextRunApprox(job),
        safeToRunNow: job.safeToRunNow,
      };
    }),
  };
};

/** POST /admin/system/jobs/:name/run — only jobs marked safeToRunNow. */
const runJobNow = async (ctx: AuditCtx | undefined, name: string) => {
  const job = findJob(name);
  if (!job) throw new ApiError(StatusCodes.NOT_FOUND, "No such job");
  if (!job.safeToRunNow) {
    throw new ApiError(StatusCodes.CONFLICT, "This job only runs on its timer");
  }

  const running = runJob(job.name, job.run, "manual");
  const outcome = await Promise.race<JobOutcome | null>([
    running,
    new Promise((resolve) => setTimeout(() => resolve(null), MANUAL_RUN_WAIT_MS).unref?.()),
  ]);

  await audit(ctx, {
    action: "job.run_manual",
    entityType: "job",
    entityId: job.name,
    after: outcome
      ? { status: outcome.status, runId: outcome.runId, durationMs: outcome.durationMs }
      : { status: "RUNNING" },
  });

  return (
    outcome ?? { status: "RUNNING" as const, runId: null, durationMs: MANUAL_RUN_WAIT_MS, summary: null, error: null }
  );
};

// ---------------------------------------------------------------- integrations

const PAYMENT_PROVIDERS = [
  { id: "SSLCOMMERZ", label: "SSLCommerz", live: () => config.sslcz.isLive },
  { id: "BKASH", label: "bKash", live: () => config.bkash.isLive },
] as const;

const integrations = async () => {
  const now = Date.now();
  const [lastSuccess, stuck, tokens, tryOnJobs, tryOnEnabled, bkashEnabled] = await Promise.all([
    prisma.paymentIntent.groupBy({ by: ["provider"], where: { status: "SUCCESS" }, _max: { updatedAt: true } }),
    prisma.paymentIntent.groupBy({
      by: ["provider"],
      where: { status: "PENDING", createdAt: { lt: new Date(now - HOUR) } },
      _count: { _all: true },
    }),
    prisma.gatewayToken.findMany({ select: { provider: true, expiresAt: true, refreshExpiresAt: true } }),
    prisma.hairTryOnJob.groupBy({
      by: ["status"],
      where: { createdAt: { gte: new Date(now - DAY) } },
      _count: { _all: true },
    }),
    getSetting("hairTryOn.enabled"),
    getSetting("payments.bkashEnabled"),
  ]);

  // Email
  const mail = emailHealth();
  const email = {
    ...mail,
    status: (mail.provider === "none"
      ? "down"
      : mail.failures24h > 0 && mail.sentSinceBoot === 0
        ? "down"
        : mail.failures24h > 0
          ? "warning"
          : "ok") as HealthLevel,
    detail:
      mail.provider === "none"
        ? "No email provider configured"
        : mail.failures24h > 0
          ? `${mail.failures24h} failed send(s) in 24 h via ${mail.provider} (this server process)`
          : `Sending via ${mail.provider}; no failures in 24 h (this server process)`,
  };

  // Payments
  const providers = PAYMENT_PROVIDERS.map((p) => {
    const enabled = p.id === "BKASH" ? bkashEnabled : true;
    const stuckCount = stuck.find((s) => s.provider === p.id)?._count._all ?? 0;
    const token = tokens.find((t) => t.provider.toUpperCase() === p.id);
    return {
      provider: p.id,
      label: p.label,
      enabled,
      mode: p.live() ? ("live" as const) : ("sandbox" as const),
      lastSuccessAt: lastSuccess.find((s) => s.provider === p.id)?._max.updatedAt ?? null,
      stuck: stuckCount,
      tokenExpiresAt: token?.expiresAt ?? null,
      refreshExpiresAt: token?.refreshExpiresAt ?? null,
    };
  });
  const stuckTotal = providers.reduce((n, p) => n + p.stuck, 0);
  const payments = {
    providers,
    status: (stuckTotal > 0 ? "warning" : "ok") as HealthLevel,
    detail:
      stuckTotal > 0
        ? `${stuckTotal} payment(s) PENDING for over an hour`
        : providers
            .filter((p) => p.enabled)
            .map((p) => `${p.label} ${p.mode}`)
            .join(" · "),
  };

  // Gemini
  const models = geminiModelState();
  const cooling = models.filter((m) => m.coolingDown);
  const configured = isGeminiConfigured();
  const gemini = {
    configured,
    models,
    status: (!configured
      ? "down"
      : cooling.length === models.length && models.length > 0
        ? "down"
        : cooling.length
          ? "warning"
          : "ok") as HealthLevel,
    detail: !configured
      ? "GEMINI_API_KEY is not set"
      : cooling.length
        ? `${cooling.length} of ${models.length} model(s) cooling down: ${cooling.map((m) => m.model).join(", ")}`
        : `${models.length} model(s) ready`,
  };

  // Try-on
  const count = (s: string) => tryOnJobs.find((j) => j.status === s)?._count._all ?? 0;
  const total = tryOnJobs.reduce((n, j) => n + j._count._all, 0);
  const failed24h = count("FAILED");
  const tryOn = {
    enabled: tryOnEnabled,
    jobs24h: total,
    failed24h,
    status: (!tryOnEnabled
      ? "off"
      : failed24h >= 3 && failed24h * 2 >= total
        ? "down"
        : failed24h > 0
          ? "warning"
          : "ok") as HealthLevel,
    detail: !tryOnEnabled
      ? "Turned off in settings"
      : `${failed24h} of ${total} generation(s) failed in 24 h`,
  };

  return {
    email,
    payments,
    gemini,
    tryOn,
    version: {
      commit: process.env.RENDER_GIT_COMMIT ?? null,
      bootedAt: new Date(Date.now() - process.uptime() * 1000),
    },
  };
};

// ---------------------------------------------------------------- storage

/** How long each table's rows live (static; kept in step with the jobs). */
const RETENTION: Record<string, string> = {
  job_runs: "14 days",
  audit_logs: "audit.retentionDays",
  visitor_daily: "35 days",
  search_query_daily: "90 days",
  event_daily: "400 days",
  metric_daily: "Kept",
  assistant_conversations: "30 days guests · 90 days customers",
  assistant_messages: "With their conversation",
  hair_tryon_uploads: "Photos 24 h · rows 30 days",
  hair_tryon_jobs: "Results 24 h · rows 30 days",
  otp_challenges: "7 days",
  verification_tokens: "7 days after use or expiry",
  support_tickets: "Kept (closed after 7 days resolved)",
  alert_states: "Kept (one row per check)",
};

const storage = async () => {
  const [db, tables, auditDays] = await Promise.all([
    databaseStorage(),
    prisma.$queryRaw<Array<{ table: string; bytes: bigint; rows: bigint }>>`
      SELECT c.relname AS table,
             pg_total_relation_size(c.oid)::bigint AS bytes,
             GREATEST(c.reltuples, 0)::bigint AS rows
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname = 'public'
      ORDER BY pg_total_relation_size(c.oid) DESC
      LIMIT 10`,
    getSetting("audit.retentionDays"),
  ]);
  return {
    ...db,
    tables: tables.map((t) => {
      const retention = RETENTION[t.table] ?? "Kept";
      return {
        table: t.table,
        bytes: Number(t.bytes),
        rowsApprox: Number(t.rows),
        retention: retention === "audit.retentionDays" ? `${auditDays} days` : retention,
      };
    }),
  };
};

export const AdminSystemService = { listJobs, runJobNow, integrations, storage };
