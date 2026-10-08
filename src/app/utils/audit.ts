import { Prisma } from "@prisma/client";
import prisma from "../shared/prisma";

/** Who did it and from where. adminAuth() puts one on req.auditCtx. */
export type AuditCtx = {
  actorUserId: string | null;
  actorRole: string;
  onBehalfOfUserId?: string | null;
  source: "api" | "job" | "cli";
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
};

export type AuditEntry = {
  action: string;
  entityType: string;
  entityId?: string | null;
  salonId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
};

const SECRET_KEY = /password|token|secret|otp|hash/i;

const scrub = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(scrub);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!SECRET_KEY.test(k)) out[k] = scrub(v);
    }
    return out;
  }
  return value;
};

/**
 * The keys that changed between two snapshots, secrets dropped. Either side
 * may be null (a create or a delete), and then the other side is kept whole.
 */
export const diff = (
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): { before: Record<string, unknown> | null; after: Record<string, unknown> | null } => {
  if (!before || !after) {
    return {
      before: before ? (scrub(before) as Record<string, unknown>) : null,
      after: after ? (scrub(after) as Record<string, unknown>) : null,
    };
  }
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (SECRET_KEY.test(key)) continue;
    const left = scrub(before[key]);
    const right = scrub(after[key]);
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      b[key] = left;
      a[key] = right;
    }
  }
  return { before: b, after: a };
};

const toJson = (v: unknown) =>
  v === undefined || v === null
    ? Prisma.DbNull
    : (scrub(v) as Prisma.InputJsonValue);

const toRow = (ctx: AuditCtx, entry: AuditEntry): Prisma.AuditLogCreateInput => ({
  actorUserId: ctx.actorUserId,
  actorRole: ctx.actorRole,
  onBehalfOfUserId: ctx.onBehalfOfUserId ?? null,
  source: ctx.source,
  ip: ctx.ip,
  userAgent: ctx.userAgent ? ctx.userAgent.slice(0, 200) : null,
  requestId: ctx.requestId,
  action: entry.action,
  entityType: entry.entityType,
  entityId: entry.entityId ?? null,
  salonId: entry.salonId ?? null,
  before: toJson(entry.before),
  after: toJson(entry.after),
  reason: entry.reason?.trim() || null,
});

/**
 * Records a write that has already committed. Never throws: a failed audit
 * write must not turn a successful action into an error response.
 */
export const audit = async (
  ctx: AuditCtx | undefined,
  entry: AuditEntry,
): Promise<void> => {
  if (!ctx) {
    console.error(`[audit] no context for ${entry.action} ${entry.entityType}:${entry.entityId ?? "-"}`);
    return;
  }
  try {
    await prisma.auditLog.create({ data: toRow(ctx, entry) });
  } catch (err) {
    console.error(`[audit] failed to record ${entry.action}`, err);
  }
};

/**
 * Records a write inside the caller's transaction, so the action and its audit
 * row commit or roll back together. Throws - use it for tier-3 money moves.
 */
export const auditTx = async (
  tx: Prisma.TransactionClient,
  ctx: AuditCtx | undefined,
  entry: AuditEntry,
): Promise<void> => {
  if (!ctx) throw new Error(`[audit] no context for ${entry.action}`);
  await tx.auditLog.create({ data: toRow(ctx, entry) });
};

/** A context for background jobs and CLI scripts. */
export const systemAuditCtx = (source: "job" | "cli"): AuditCtx => ({
  actorUserId: null,
  actorRole: "SYSTEM",
  source,
  ip: null,
  userAgent: null,
  requestId: null,
});

/** What a service needs to audit a write it performs on an admin's behalf. */
export type AuditOpts = { ctx?: AuditCtx; reason?: string | null };
