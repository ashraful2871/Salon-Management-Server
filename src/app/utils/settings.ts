import { Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import ApiError from "../Error/error";
import prisma from "../shared/prisma";
import { audit, AuditCtx } from "./audit";

/**
 * Platform settings: values the admin console can change without a deploy.
 *
 * A value resolves as the `platform_settings` row, else the env var that set it
 * before this registry existed, else the code default - so with an empty table
 * every value is exactly what it was. Rows are cached in-process for 30 s; a
 * write refreshes this process's copy at once.
 */

export type SettingGroup =
  | "money"
  | "limits"
  | "flags"
  | "security"
  | "approvals"
  | "retention"
  | "system"
  | "content";

export type SettingKind = "int" | "number" | "boolean" | "announcement";

type Entry<T> = {
  schema: z.ZodType<T>;
  kind: SettingKind;
  min?: number;
  max?: number;
  default: T;
  /** The env var read before the registry, parsed; undefined when unset. */
  env?: () => T | undefined;
  envName?: string;
  group: SettingGroup;
  label: string;
  help: string;
  /** Served by GET /settings/public. */
  public?: boolean;
  /** Needs a second admin once approvals are on (Phase 8). */
  approval?: boolean;
  /** 2 = flags/content (no step-up), 3 = everything else (step-up). */
  tier: 2 | 3;
};

const def = <T>(entry: Entry<T>) => entry;

const raw = (name: string) => {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
};

const clamp = (n: number, min = -Infinity, max = Infinity) =>
  Math.min(Math.max(n, min), max);

/** A numeric env var clamped to the setting's bounds, as the old readers did. */
const envNumber = (name: string, min?: number, max?: number, integer = false) => () => {
  const v = raw(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return clamp(integer ? Math.floor(n) : n, min, max);
};

/** `onUnlessFalse`: unset or anything but "false" is on (the old `!== "false"`). */
const envFlag = (name: string, mode: "onUnlessFalse" | "onlyTrue") => () => {
  const v = raw(name);
  if (v === undefined) return undefined;
  return mode === "onlyTrue" ? v === "true" : v !== "false";
};

const int = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  ({ schema: z.number().int().min(min).max(max), kind: "int" as const, min, max: max === Number.MAX_SAFE_INTEGER ? undefined : max });
const num = (min: number, max: number) =>
  ({ schema: z.number().min(min).max(max), kind: "number" as const, min, max });
const bool = () => ({ schema: z.boolean(), kind: "boolean" as const });

const announcementSchema = z
  .object({
    message: z.string().trim().min(1).max(200),
    tone: z.enum(["info", "warning"]),
    href: z
      .string()
      .trim()
      .max(300)
      .refine((h) => h.startsWith("/") || /^https:\/\//.test(h), "Use a /path or an https:// link")
      .optional(),
    startsAt: z.iso.datetime({ offset: true }).optional(),
    endsAt: z.iso.datetime({ offset: true }).optional(),
    dismissible: z.boolean(),
  })
  .refine((a) => !a.startsAt || !a.endsAt || Date.parse(a.startsAt) < Date.parse(a.endsAt), {
    message: "The end must be after the start",
  })
  .nullable();

export type Announcement = z.infer<typeof announcementSchema>;

export const SETTINGS = {
  "booking.commissionPercent": def<number>({
    ...num(0, 30),
    default: 10,
    env: envNumber("PLATFORM_COMMISSION_PERCENT", 0, 30),
    envName: "PLATFORM_COMMISSION_PERCENT",
    group: "money",
    label: "Platform commission (%)",
    help: "Charged on each completed booking. New bookings keep the rate in force when they were made.",
    approval: true,
    tier: 3,
  }),
  "booking.depositMinMinor": def<number>({
    ...int(0, 100000),
    default: 2000,
    group: "money",
    label: "Minimum deposit (poisha)",
    help: "A salon's deposit is never below this (and never above the bill).",
    tier: 3,
  }),
  "booking.depositMaxMinor": def<number>({
    ...int(1000, 500000),
    default: 50000,
    group: "money",
    label: "Maximum deposit (poisha)",
    help: "A salon's deposit is never above this.",
    tier: 3,
  }),
  "booking.goodwillCreditMinor": def<number>({
    ...int(0, 50000),
    default: 2000,
    group: "money",
    label: "Goodwill credit (poisha)",
    help: "Paid by the salon to the customer when the salon cancels.",
    tier: 3,
  }),
  "booking.lateCancellationPercent": def<number>({
    ...num(0, 100),
    default: 20,
    env: envNumber("LATE_CANCELLATION_PENALTY_PERCENT", 0, 100),
    envName: "LATE_CANCELLATION_PENALTY_PERCENT",
    group: "money",
    label: "Late cancellation fee (% of deposit)",
    help: "What a customer loses for cancelling inside the salon's window.",
    tier: 3,
  }),
  "booking.noShowGraceMinutes": def<number>({
    ...int(0, 120),
    default: 20,
    env: envNumber("NO_SHOW_GRACE_MINUTES", 0, 120, true),
    envName: "NO_SHOW_GRACE_MINUTES",
    group: "limits",
    label: "No-show grace (minutes)",
    help: "How late a customer can be before the auto no-show job marks them.",
    tier: 3,
  }),
  "booking.maxActiveBookingsPerDay": def<number>({
    ...int(1, 50),
    default: 3,
    env: envNumber("MAX_ACTIVE_BOOKINGS_PER_DAY", 1, 50, true),
    envName: "MAX_ACTIVE_BOOKINGS_PER_DAY",
    group: "limits",
    label: "Bookings per customer, salon and day",
    help: "Live bookings one customer may hold at one salon on one day.",
    tier: 3,
  }),
  "booking.staleCheckoutHours": def<number>({
    ...int(1, 48),
    default: 12,
    env: envNumber("STALE_CHECKOUT_HOURS", 1, 48, true),
    envName: "STALE_CHECKOUT_HOURS",
    group: "limits",
    label: "Close stale check-ins after (hours)",
    help: "After the scheduled end, a checked-in booking left open is closed by the job.",
    tier: 3,
  }),
  "assistant.enabled": def<boolean>({
    ...bool(),
    default: true,
    env: envFlag("ASSISTANT_ENABLED", "onUnlessFalse"),
    envName: "ASSISTANT_ENABLED",
    group: "flags",
    label: "Booking assistant",
    help: "Off, the chat and its launcher disappear.",
    public: true,
    tier: 2,
  }),
  "assistant.llmEnabled": def<boolean>({
    ...bool(),
    default: false,
    env: envFlag("ASSISTANT_LLM_ENABLED", "onlyTrue"),
    envName: "ASSISTANT_LLM_ENABLED",
    group: "flags",
    label: "Assistant free text (Gemini)",
    help: "Off, typed messages are read by the rules alone (guided mode).",
    tier: 2,
  }),
  "assistant.topupEnabled": def<boolean>({
    ...bool(),
    default: true,
    env: envFlag("ASSISTANT_TOPUP_ENABLED", "onUnlessFalse"),
    envName: "ASSISTANT_TOPUP_ENABLED",
    group: "flags",
    label: "Top-ups from the chat",
    help: "Turn off while the payment gateway is having trouble.",
    tier: 2,
  }),
  "assistant.dailyTokenBudget": def<number>({
    ...int(0),
    default: 2_000_000,
    // As before: an unparseable or zero env value meant the default.
    env: () => {
      const n = envNumber("ASSISTANT_DAILY_TOKEN_BUDGET", 0, undefined, true)();
      return n === undefined ? undefined : n || 2_000_000;
    },
    envName: "ASSISTANT_DAILY_TOKEN_BUDGET",
    group: "limits",
    label: "Assistant daily token budget",
    help: "Tokens the assistant may spend per Dhaka day before falling back to guided mode.",
    tier: 3,
  }),
  "hairTryOn.enabled": def<boolean>({
    ...bool(),
    default: false,
    env: envFlag("HAIR_TRYON_ENABLED", "onlyTrue"),
    envName: "HAIR_TRYON_ENABLED",
    group: "flags",
    label: "Hairstyle try-on",
    help: "Off, the try-on tool says it is resting.",
    public: true,
    tier: 2,
  }),
  "hairTryOn.dailyCap": def<number>({
    ...int(0, 5000),
    default: 300,
    env: envNumber("HAIR_TRYON_DAILY_CAP", 0, 5000, true),
    envName: "HAIR_TRYON_DAILY_CAP",
    group: "limits",
    label: "Try-on generations per day",
    help: "Process-wide ceiling on hairstyle generations per day.",
    tier: 3,
  }),
  "payments.bkashEnabled": def<boolean>({
    ...bool(),
    default: false,
    env: envFlag("BKASH_ENABLED", "onlyTrue"),
    envName: "BKASH_ENABLED",
    group: "flags",
    label: "bKash payments",
    help: "Also needs the bKash credentials in the environment.",
    tier: 2,
  }),
  "ai.searchLimit": def<number>({
    ...int(1, 12),
    default: 6,
    env: envNumber("AI_SEARCH_LIMIT", 1, 12, true),
    envName: "AI_SEARCH_LIMIT",
    group: "limits",
    label: "AI search results",
    help: "Salons returned by an AI search when the caller asks for no number.",
    tier: 3,
  }),
  "signup.enabled": def<boolean>({
    ...bool(),
    default: true,
    group: "flags",
    label: "New sign-ups",
    help: "Whether new accounts can be created.",
    public: true,
    tier: 2,
  }),
  "applications.enabled": def<boolean>({
    ...bool(),
    default: true,
    group: "flags",
    label: "Salon owner applications",
    help: "Whether customers can apply to become salon owners.",
    public: true,
    tier: 2,
  }),
  "security.stepUpMinutes": def<number>({
    ...int(5, 30),
    default: 10,
    group: "security",
    label: "Step-up window (minutes)",
    help: "How long one authenticator code unlocks sensitive admin actions.",
    tier: 3,
  }),
  "approvals.enabled": def<boolean>({
    ...bool(),
    default: false,
    group: "approvals",
    label: "Four-eyes approvals",
    help: "Changes marked for approval need a second admin.",
    tier: 3,
  }),
  "approvals.walletAdjustOverMinor": def<number>({
    ...int(0),
    default: 100000,
    group: "approvals",
    label: "Wallet adjustments over (poisha)",
    help: "Larger adjustments need a second admin when approvals are on.",
    tier: 3,
  }),
  "approvals.refundOverMinor": def<number>({
    ...int(0),
    default: 200000,
    group: "approvals",
    label: "Refunds over (poisha)",
    help: "Larger refunds need a second admin when approvals are on.",
    tier: 3,
  }),
  "audit.retentionDays": def<number>({
    ...int(90, 3650),
    default: 365,
    group: "retention",
    label: "Audit log retention (days)",
    help: "Audit rows older than this are purged.",
    tier: 3,
  }),
  "system.storageCapBytes": def<number>({
    ...int(1),
    default: 536870912,
    group: "system",
    label: "Database storage cap (bytes)",
    help: "The hosting plan's storage limit.",
    tier: 3,
  }),
  "system.storageWarnPercent": def<number>({
    ...int(50, 95),
    default: 70,
    group: "system",
    label: "Storage warning at (%)",
    help: "Alert when the database passes this share of the cap.",
    tier: 3,
  }),
  "content.announcement": def<Announcement>({
    schema: announcementSchema,
    kind: "announcement",
    default: null,
    group: "content",
    label: "Site announcement",
    help: "A bar above the public navbar, shown inside its time window.",
    public: true,
    tier: 2,
  }),
};

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = (typeof SETTINGS)[K]["default"];
export type SettingSource = "db" | "env" | "default";

export const isSettingKey = (key: string): key is SettingKey =>
  Object.prototype.hasOwnProperty.call(SETTINGS, key);

/** The permission a change to this key needs. */
export const settingPermission = (key: SettingKey) => {
  const { group } = SETTINGS[key];
  if (group === "flags") return "flags.manage" as const;
  if (group === "content") return "content.manage" as const;
  return "settings.manage" as const;
};

/** Read-only on the settings page: whether each is set, never its value. */
export const ENV_ONLY = [
  "DATABASE_URL",
  "JWT_SECRET",
  "REFRESH_TOKEN_SECRET",
  "AUTH_OTP_SECRET",
  "MFA_ENCRYPTION_KEY",
  "ASSISTANT_TOKEN_SECRET",
  "INTERNAL_API_KEY",
  "GEMINI_API_KEY",
  "RESEND_API_KEY",
  "SMTP_PASS",
  "CLOUDINARY_API_SECRET",
  "TURNSTILE_SECRET_KEY",
  "GOOGLE_CLIENT_SECRET",
  "SSLCZ_STORE_PASSWD",
  "BKASH_APP_SECRET",
  "BKASH_PASSWORD",
  "BKASH_IS_LIVE",
  "SSLCZ_IS_LIVE",
  "DISABLE_BACKGROUND_JOBS",
  "GEMINI_CHAT_MODEL",
  "GEMINI_EMBEDDING_MODEL",
  "EMAIL_PROVIDER",
] as const;

export const envOnlyStatus = () =>
  ENV_ONLY.map((name) => ({ name, set: raw(name) !== undefined }));

/* ------------------------------------------------------------------ cache */

type Row = { value: unknown; version: number; updatedById: string | null; updatedAt: Date };

const TTL_MS = 30_000;
let rows = new Map<string, Row>();
let loadedAt = 0;
let loading: Promise<void> | null = null;
let failing = false;

const refresh = (): Promise<void> => {
  loading ??= prisma.platformSetting
    .findMany()
    .then((found) => {
      rows = new Map(found.map((r) => [r.key, r]));
      failing = false;
    })
    .catch((err) => {
      // Keep the last rows (or env/defaults) and retry after the TTL.
      if (!failing) console.error("[settings] could not load platform_settings", err);
      failing = true;
    })
    .finally(() => {
      loadedAt = Date.now();
      loading = null;
    });
  return loading;
};

const stale = () => Date.now() - loadedAt > TTL_MS;

const resolve = <K extends SettingKey>(key: K): { value: SettingValue<K>; source: SettingSource } => {
  const entry = SETTINGS[key] as Entry<SettingValue<K>>;
  const row = rows.get(key);
  if (row) {
    const parsed = entry.schema.safeParse(row.value);
    if (parsed.success) return { value: parsed.data, source: "db" };
    console.error(`[settings] stored value for ${key} is invalid; using the fallback`);
  }
  const fromEnv = entry.env?.();
  if (fromEnv !== undefined) return { value: fromEnv, source: "env" };
  return { value: entry.default, source: "default" };
};

/** The value in force: the row, else the env var, else the default. */
export const getSetting = async <K extends SettingKey>(key: K): Promise<SettingValue<K>> => {
  if (stale()) await refresh();
  return resolve(key).value;
};

/**
 * For synchronous call sites (pure helpers deep in a flow). Reads the cached
 * rows and refreshes them in the background when stale, so it can lag a
 * change made on another instance by up to one read. Before the first load it
 * answers from env/defaults - today's values.
 */
export const getSettingSync = <K extends SettingKey>(key: K): SettingValue<K> => {
  if (stale()) void refresh();
  return resolve(key).value;
};

export const publicSettings = async () => {
  if (stale()) await refresh();
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(SETTINGS) as SettingKey[]) {
    if ((SETTINGS[key] as Entry<unknown>).public) out[key] = resolve(key).value;
  }
  return out;
};

/** Every entry with its value, source and bounds, for the admin page. */
export const describeSettings = async () => {
  await refresh();
  return (Object.keys(SETTINGS) as SettingKey[]).map((key) => {
    const entry = SETTINGS[key] as Entry<unknown>;
    const { value, source } = resolve(key);
    const row = rows.get(key);
    return {
      key,
      group: entry.group,
      label: entry.label,
      help: entry.help,
      kind: entry.kind,
      bounds: { min: entry.min ?? null, max: entry.max ?? null },
      value,
      default: entry.default,
      envName: entry.envName ?? null,
      source,
      public: Boolean(entry.public),
      approval: Boolean(entry.approval),
      tier: entry.tier,
      permission: settingPermission(key),
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt ?? null,
      updatedById: row?.updatedById ?? null,
    };
  });
};

/** Validates, upserts with version + 1, refreshes the cache and audits. */
export const setSetting = async <K extends SettingKey>(
  key: K,
  value: unknown,
  ctx: AuditCtx | undefined,
  reason: string,
) => {
  const entry = SETTINGS[key] as Entry<SettingValue<K>>;
  const parsed = entry.schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      parsed.error.issues[0]?.message ?? "That value is not allowed",
    );
  }

  // The audit's "before" comes from the database, not this process's cache,
  // which can lag a change made by another instance by up to 30 s.
  const current = await prisma.platformSetting.findUnique({ where: { key } });
  if (current) rows.set(key, current);
  else rows.delete(key);
  const before = resolve(key);
  const json = parsed.data === null ? Prisma.JsonNull : (parsed.data as Prisma.InputJsonValue);
  const updatedById = ctx?.actorUserId ?? null;

  const row = await prisma.platformSetting.upsert({
    where: { key },
    create: { key, value: json, updatedById },
    update: { value: json, version: { increment: 1 }, updatedById },
  });
  rows.set(key, row);

  await audit(ctx, {
    action: "setting.update",
    entityType: "setting",
    entityId: key,
    before: { value: before.value, source: before.source },
    after: { value: parsed.data, version: row.version },
    reason,
  });

  return { key, value: parsed.data, version: row.version, updatedAt: row.updatedAt };
};
