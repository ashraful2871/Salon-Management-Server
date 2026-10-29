import { Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import ApiError from "../Error/error";
import prisma from "../shared/prisma";
import { audit, AuditCtx } from "./audit";

import { SITE_NAME } from "./brand";
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
  | "content"
  | "homeService";

export type SettingKind = "int" | "number" | "boolean" | "announcement" | "list" | "text" | "choice";

type Entry<T> = {
  schema: z.ZodType<T>;
  kind: SettingKind;
  min?: number;
  max?: number;
  /** The allowed values of a `choice`. */
  options?: readonly string[];
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
const text = (max: number) => ({ schema: z.string().trim().max(max), kind: "text" as const });
const envText = (name: string) => () => raw(name);
const choice = <const T extends readonly [string, ...string[]]>(options: T) =>
  ({ schema: z.enum(options), kind: "choice" as const, options });
/** A Dhaka wall-clock time, "HH:MM". */
const time = () => ({
  schema: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "Use HH:MM")
    .refine((t) => Number(t.slice(0, 2)) < 24 && Number(t.slice(3)) < 60, "Use a real time of day"),
  kind: "text" as const,
});

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

/* ---------------------------------------------------------------- content */

// The ServiceCategory enum (prisma/schema/enum.prisma).
const SERVICE_CATEGORIES = [
  "HAIRCUT", "STYLING", "COLORING", "TREATMENT", "SPA", "FACIAL",
  "MANICURE", "PEDICURE", "MAKEUP", "WAXING", "MASSAGE", "OTHER",
] as const;

/** Lucide icon names a category tile may use; the frontend maps each to a component. */
export const CONTENT_ICONS = [
  "Scissors", "Wind", "Palette", "Sparkles", "Smile", "Brush", "Hand",
  "Footprints", "Feather", "HeartHandshake", "Flower2", "Store", "Star",
  "Gem", "Crown", "Droplet", "Leaf", "Heart", "Flame", "Sun",
] as const;

export const MAX_FEATURED_SALONS = 8;

const featuredSalonIdsSchema = z
  .array(z.uuid("Each featured salon must be a salon id"))
  .max(MAX_FEATURED_SALONS, `At most ${MAX_FEATURED_SALONS} featured salons`)
  .refine((ids) => new Set(ids).size === ids.length, "A salon is listed twice");

const homeChipSchema = z
  .object({
    label: z.string().trim().min(1).max(24),
    query: z.string().trim().min(1).max(100).optional(),
    category: z.enum(SERVICE_CATEGORIES).optional(),
  })
  .refine((c) => Boolean(c.query) !== Boolean(c.category), {
    message: "Each chip needs a search text or a category (not both)",
  });

const homeChipsSchema = z.array(homeChipSchema).max(12, "At most 12 chips");

const categoryTileSchema = z.object({
  category: z.enum(SERVICE_CATEGORIES),
  labelEn: z.string().trim().min(1).max(40),
  labelBn: z.string().trim().min(1).max(40),
  icon: z.enum(CONTENT_ICONS),
  order: z.number().int().min(0).max(99),
  visible: z.boolean(),
});

const categoryTilesSchema = z
  .array(categoryTileSchema)
  .max(SERVICE_CATEGORIES.length)
  .refine((t) => new Set(t.map((x) => x.category)).size === t.length, "A category is listed twice");

export type HomeChip = z.infer<typeof homeChipSchema>;
export type CategoryTile = z.infer<typeof categoryTileSchema>;

// Today's hardcoded home content (frontend HeroSearch + ServiceCategories),
// so an empty table renders exactly what shipped before.
const DEFAULT_CHIPS: HomeChip[] = [
  { label: "Haircut", category: "HAIRCUT" },
  { label: "Facial", category: "FACIAL" },
  { label: "Makeup", category: "MAKEUP" },
  { label: "Manicure", category: "MANICURE" },
  { label: "Massage", category: "MASSAGE" },
];

const DEFAULT_TILES: CategoryTile[] = (
  [
    ["HAIRCUT", "Haircut", "চুল কাটা", "Scissors"],
    ["STYLING", "Styling", "স্টাইলিং", "Wind"],
    ["COLORING", "Hair colour", "চুলের রং", "Palette"],
    ["TREATMENT", "Hair treatment", "চুলের যত্ন", "Sparkles"],
    ["FACIAL", "Facial", "ফেসিয়াল", "Smile"],
    ["MAKEUP", "Makeup", "মেকআপ", "Brush"],
    ["MANICURE", "Manicure", "ম্যানিকিউর", "Hand"],
    ["PEDICURE", "Pedicure", "পেডিকিউর", "Footprints"],
    ["WAXING", "Waxing", "ওয়াক্সিং", "Feather"],
    ["MASSAGE", "Massage", "ম্যাসাজ", "HeartHandshake"],
    ["SPA", "Spa", "স্পা", "Flower2"],
  ] as const
).map(([category, labelEn, labelBn, icon], order) => ({
  category,
  labelEn,
  labelBn,
  icon,
  order,
  visible: true,
}));

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
  "booking.commissionOnDirect": def<boolean>({
    ...bool(),
    default: false,
    env: envFlag("COMMISSION_ON_DIRECT", "onlyTrue"),
    envName: "COMMISSION_ON_DIRECT",
    group: "money",
    label: "Commission on the salon's own walk-ins",
    help: "Off: a SALON_DIRECT booking completed from now on pays no commission. Earlier bookings are not changed.",
    approval: true,
    tier: 3,
  }),
  "payouts.holdDays": def<number>({
    ...int(0, 60),
    default: 7,
    group: "money",
    label: "Payout hold (days)",
    help: "Earnings stay pending this long before a payout can take them.",
    tier: 3,
  }),
  "payouts.minMinor": def<number>({
    ...int(0, 10000000),
    default: 50000,
    group: "money",
    label: "Minimum payout (poisha)",
    help: "A business with less available than this is carried to the next run.",
    tier: 3,
  }),
  "payouts.weekday": def<number>({
    ...int(0, 6),
    default: 1,
    group: "money",
    label: "Payout weekday (0 = Sunday)",
    help: "The day payouts are run, 09:00 Asia/Dhaka. Shown to owners as the next payout date.",
    tier: 3,
  }),
  "payouts.accountCooldownHours": def<number>({
    ...int(0, 720),
    default: 72,
    group: "money",
    label: "New payout account cooldown (hours)",
    help: "A changed payout account is not paid to until this long after the change.",
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
  "booking.prepayEnabled": def<boolean>({
    ...bool(),
    default: false,
    group: "money",
    label: "Let customers pay in full in the app",
    public: true,
    help: "On: at a salon that opted in, a customer can pay the whole bill from their wallet when booking. The salon gets it in the weekly payout, less commission.",
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
  "security.notifyOnImpersonation": def<boolean>({
    ...bool(),
    default: true,
    group: "security",
    label: "Email users on \"View as\"",
    help: "Tell a customer or owner by email when support starts viewing their account.",
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
  "approvals.payoutOverMinor": def<number | null>({
    schema: z.number().int().min(0).nullable(),
    kind: "int",
    min: 0,
    default: null,
    group: "approvals",
    label: "Payouts over (poisha)",
    help: "When approvals are on, only payouts larger than this need a second admin to mark paid. None = every payout does.",
    tier: 3,
  }),
  "approvals.duesAdjustOverMinor": def<number>({
    ...int(0),
    default: 100000,
    group: "approvals",
    label: "Dues waivers over (poisha)",
    help: "Larger dues adjustments need a second admin when approvals are on.",
    tier: 3,
  }),
  "dues.pauseEnabled": def<boolean>({
    ...bool(),
    default: false,
    group: "money",
    label: "Pause online bookings for unpaid dues",
    help: "On: an owner over the dues limit or age is warned, then 3 days later every branch stops taking online bookings until paid.",
    tier: 3,
  }),
  "dues.creditLimitMinor": def<number>({
    ...int(0, 10000000),
    default: 200000, // ৳2,000 (owner decision D5)
    group: "money",
    label: "Dues limit before pause (poisha)",
    help: "Dues above this start the pause warning.",
    tier: 3,
  }),
  "dues.maxAgeDays": def<number>({
    ...int(1, 365),
    default: 30,
    group: "money",
    label: "Dues age before pause (days)",
    help: "Dues outstanding longer than this start the pause warning, whatever the amount.",
    tier: 3,
  }),
  // Owner statements and invoices (owner Phase 7): the seller block on every
  // invoice, and the VAT shown inside the commission (0 = no VAT line).
  "finance.legalName": def<string>({
    ...text(120),
    default: SITE_NAME,
    env: envText("PLATFORM_LEGAL_NAME"),
    envName: "PLATFORM_LEGAL_NAME",
    group: "money",
    label: "Platform legal name",
    help: "Printed as the seller on commission invoices and statements.",
    tier: 3,
  }),
  "finance.bin": def<string>({
    ...text(40),
    default: "",
    env: envText("PLATFORM_BIN"),
    envName: "PLATFORM_BIN",
    group: "money",
    label: "Platform BIN",
    help: "VAT Business Identification Number on invoices. Empty hides the line.",
    tier: 3,
  }),
  "finance.vatPercent": def<number>({
    ...num(0, 25),
    default: 0,
    group: "money",
    label: "VAT on commission (%)",
    help: "VAT included in the commission on new invoices. Issued invoices keep their rate.",
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
  // Not public itself: GET /settings/public serves the resolved `featuredSalons`.
  "content.featuredSalonIds": def<string[]>({
    schema: featuredSalonIdsSchema,
    kind: "list",
    default: [],
    group: "content",
    label: "Featured salons",
    help: "Shown first in the home page's top-rated row, in this order. Only ACTIVE salons appear.",
    tier: 2,
  }),
  "content.homeChips": def<HomeChip[]>({
    schema: homeChipsSchema,
    kind: "list",
    default: DEFAULT_CHIPS,
    group: "content",
    label: "Popular search chips",
    help: "The chips under the home search box.",
    public: true,
    tier: 2,
  }),
  "content.categoryTiles": def<CategoryTile[]>({
    schema: categoryTilesSchema,
    kind: "list",
    default: DEFAULT_TILES,
    group: "content",
    label: "Category tiles",
    help: "The home page's \"Browse by service\" tiles.",
    public: true,
    tier: 2,
  }),

  /* ----------------------------------------------------------- home service */
  // Launch: no fee anywhere, policy FREE. Kill switches are flags; the rest is
  // group homeService (homeservice.policy, tier 3).

  "homeService.enabled": def<boolean>({
    ...bool(),
    default: true,
    group: "flags",
    label: "Home Service",
    help: "Kill switch: off hides Home Service everywhere and stops new home bookings.",
    public: true,
    tier: 2,
  }),
  "homeService.ladiesEnabled": def<boolean>({
    ...bool(),
    default: true,
    group: "flags",
    label: "Ladies at Home",
    help: "Off hides the Ladies side and stops new Ladies home bookings.",
    public: true,
    tier: 2,
  }),
  "homeService.gentsEnabled": def<boolean>({
    ...bool(),
    default: true,
    group: "flags",
    label: "Gents at Home",
    help: "Off hides the Gents side and stops new Gents home bookings.",
    public: true,
    tier: 2,
  }),
  "homeService.requireApproval": def<boolean>({
    ...bool(),
    default: true,
    group: "homeService",
    label: "Review a branch's first turn-on",
    help: "On: a branch's first turn-on waits for an admin before customers can see it.",
    tier: 3,
  }),
  "homeService.customerCancelPolicy": def<"FREE" | "WINDOW" | "NON_REFUNDABLE">({
    ...choice(["FREE", "WINDOW", "NON_REFUNDABLE"]),
    default: "FREE",
    group: "homeService",
    label: "Customer cancellation policy",
    help: "What a customer gets back when they cancel; each booking keeps the policy in force when it was made.",
    public: true,
    approval: true,
    tier: 3,
  }),
  "homeService.nonRefundableGraceMinutes": def<number>({
    ...int(0, 1440),
    default: 0,
    group: "homeService",
    label: "Non-refundable grace (minutes)",
    help: "Under Non-refundable, a customer can still cancel free this long after paying if the visit is far enough away.",
    public: true,
    approval: true,
    tier: 3,
  }),
  "homeService.disclaimer.free": def<string>({
    ...text(400),
    default: "",
    group: "homeService",
    label: "Disclaimer: Free cancellation",
    help: "The text a customer ticks before paying under the Free policy; empty uses the generated text.",
    public: true,
    tier: 3,
  }),
  "homeService.disclaimer.window": def<string>({
    ...text(400),
    default: "",
    group: "homeService",
    label: "Disclaimer: Cancellation window",
    help: "The text a customer ticks before paying under the Window policy; empty uses the generated text.",
    public: true,
    tier: 3,
  }),
  "homeService.disclaimer.nonRefundable": def<string>({
    ...text(400),
    default: "",
    group: "homeService",
    label: "Disclaimer: Non-refundable",
    help: "The text a customer ticks before paying under the Non-refundable policy; empty uses the generated text.",
    public: true,
    tier: 3,
  }),
  "homeService.commissionPercent": def<number>({
    ...num(0, 30),
    default: 0,
    group: "homeService",
    label: "Home commission (%)",
    help: "The platform's cut of a completed visit's services (never the travel fee), taken from the salon's share.",
    approval: true,
    tier: 3,
  }),
  "homeService.lateCancelPercent": def<number>({
    ...num(0, 100),
    default: 0,
    group: "homeService",
    label: "Late cancellation fee (% of advance)",
    help: "Under the Window policy, what a customer loses for cancelling inside the free window.",
    public: true,
    approval: true,
    tier: 3,
  }),
  "homeService.noShowPercent": def<number>({
    ...num(0, 100),
    default: 0,
    group: "homeService",
    label: "Customer no-show fee (% of advance)",
    help: "What a customer loses when the expert arrives and they are not there (Free and Window policies).",
    public: true,
    approval: true,
    tier: 3,
  }),
  "homeService.salonCancelCreditMinor": def<number>({
    ...int(0, 100_000),
    default: 0,
    group: "homeService",
    label: "Credit when the salon cancels (poisha)",
    help: "Extra wallet credit a customer gets, paid by the salon, when the salon cancels or the expert does not show.",
    public: true,
    approval: true,
    tier: 3,
  }),
  "homeService.feeSalonSharePercent": def<number>({
    ...int(0, 100),
    default: 100,
    group: "homeService",
    label: "Salon's share of kept fees (%)",
    help: "How much of a late-cancel or no-show fee goes to the booked salon; the rest stays with the platform.",
    approval: true,
    tier: 3,
  }),
  "homeService.travelFeeMaxMinor": def<number>({
    ...int(0, 100_000),
    default: 0,
    group: "homeService",
    label: "Highest travel fee a branch may charge (poisha)",
    help: "Caps the travel fee branches add to a home visit; 0 means no branch can charge one.",
    approval: true,
    tier: 3,
  }),
  "homeService.advancePercent": def<number>({
    ...int(10, 100),
    default: 50,
    group: "homeService",
    label: "Advance (% of total)",
    help: "The share of the visit total a customer pays up front; the rest is paid at the door.",
    public: true,
    approval: true,
    tier: 3,
  }),
  "homeService.paymentWindowMinutes": def<number>({
    ...int(5, 60),
    default: 15,
    group: "homeService",
    label: "Time to pay the advance (minutes)",
    help: "How long a new home booking holds its time while the customer pays.",
    tier: 3,
  }),
  "homeService.minOrderMinMinor": def<number>({
    ...int(0, 1_000_000),
    default: 20_000,
    group: "homeService",
    label: "Lowest minimum order a branch may set (poisha)",
    help: "A branch's minimum home order can't be set below this.",
    tier: 3,
  }),
  "homeService.minOrderMaxMinor": def<number>({
    ...int(0, 5_000_000),
    default: 200_000,
    group: "homeService",
    label: "Highest minimum order a branch may set (poisha)",
    help: "A branch's minimum home order can't be set above this.",
    tier: 3,
  }),
  "homeService.freeCancelHours": def<number>({
    ...int(0, 72),
    default: 3,
    group: "homeService",
    label: "Free cancellation window (hours)",
    help: "Under the Window policy, a customer cancels free until this long before the visit.",
    public: true,
    tier: 3,
  }),
  "homeService.noShowWaitMinutes": def<number>({
    ...int(5, 60),
    default: 20,
    group: "homeService",
    label: "Expert waits before a no-show (minutes)",
    help: "How long after arriving the expert must wait before marking the customer a no-show.",
    tier: 3,
  }),
  "homeService.noShowBlockThreshold": def<number>({
    ...int(1, 20),
    default: 3,
    group: "homeService",
    label: "No-shows before a block",
    help: "A customer with this many no-shows can't book Home Service for a while.",
    tier: 3,
  }),
  "homeService.noShowBlockDays": def<number>({
    ...int(1, 365),
    default: 30,
    group: "homeService",
    label: "No-show block length (days)",
    help: "How long a blocked customer waits before they can book Home Service again.",
    tier: 3,
  }),
  "homeService.appealWindowHours": def<number>({
    ...int(1, 720),
    default: 48,
    group: "homeService",
    label: "Appeal window (hours)",
    help: "How long after a cancel or no-show fee a customer can appeal it.",
    public: true,
    tier: 3,
  }),
  "homeService.bookingWindowDays": def<number>({
    ...int(1, 30),
    default: 7,
    group: "homeService",
    label: "Days customers can book ahead",
    help: "Customers pick from today and the following days, this many in all.",
    public: true,
    tier: 3,
  }),
  "homeService.minLeadMinutes": def<number>({
    ...int(0, 1440),
    default: 120,
    group: "homeService",
    label: "Minimum notice (minutes)",
    help: "The earliest start a customer can book is this long from now.",
    public: true,
    tier: 3,
  }),
  "homeService.slotStepMinutes": def<number>({
    ...int(15, 60),
    default: 30,
    group: "homeService",
    label: "Time grid (minutes)",
    help: "The spacing of the start times customers can pick.",
    tier: 3,
  }),
  "homeService.rescheduleCutoffHours": def<number>({
    ...int(0, 72),
    default: 3,
    group: "homeService",
    label: "Reschedule cut-off (hours)",
    help: "A customer can move a visit until this long before it starts.",
    public: true,
    tier: 3,
  }),
  "homeService.maxRescheduleCount": def<number>({
    ...int(0, 5),
    default: 1,
    group: "homeService",
    label: "Reschedules per booking",
    help: "How many times a customer can move one home visit.",
    public: true,
    tier: 3,
  }),
  "homeService.maxRadiusKm": def<number>({
    ...int(1, 30),
    default: 10,
    group: "homeService",
    label: "Largest service radius (km)",
    help: "The farthest a branch can set its experts to travel.",
    tier: 3,
  }),
  "homeService.dayStartBound": def<string>({
    ...time(),
    default: "08:00",
    group: "homeService",
    label: "Earliest visit start (HH:MM)",
    help: "No branch can offer a home visit starting before this time.",
    tier: 3,
  }),
  "homeService.dayEndBound": def<string>({
    ...time(),
    default: "21:00",
    group: "homeService",
    label: "Latest visit end (HH:MM)",
    help: "No home visit can run past this time.",
    tier: 3,
  }),
  "homeService.ladiesLastStart": def<string>({
    ...time(),
    default: "19:30",
    group: "homeService",
    label: "Latest Ladies start (HH:MM)",
    help: "Ladies at Home visits can't start after this time.",
    public: true,
    tier: 3,
  }),
  "homeService.maxActivePerCustomer": def<number>({
    ...int(1, 10),
    default: 3,
    group: "homeService",
    label: "Active home bookings per customer",
    help: "How many upcoming home visits one customer can hold at once.",
    tier: 3,
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
  if (group === "homeService") return "homeservice.policy" as const;
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
/** The value plus its row version (0 = never saved), so a caller can tell whether it changed since it last read. */
export const getSettingWithVersion = async <K extends SettingKey>(
  key: K,
): Promise<{ value: SettingValue<K>; version: number }> => {
  if (stale()) await refresh();
  return { value: resolve(key).value, version: rows.get(key)?.version ?? 0 };
};

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
      options: entry.options ?? null,
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt ?? null,
      updatedById: row?.updatedById ?? null,
    };
  });
};

/** Featured salons must be ACTIVE (and not deleted) when they are picked. */
const assertFeaturable = async (ids: string[]) => {
  if (!ids.length) return;
  const found = await prisma.salon.findMany({
    where: { id: { in: ids }, status: "ACTIVE", isDeleted: false },
    select: { id: true },
  });
  const ok = new Set(found.map((s) => s.id));
  const bad = ids.filter((id) => !ok.has(id));
  if (bad.length) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `Only ACTIVE salons can be featured (${bad.length} ${bad.length === 1 ? "is" : "are"} not)`,
    );
  }
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
  if (key === "content.featuredSalonIds") await assertFeaturable(parsed.data as string[]);

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
    action: entry.group === "content" ? "content.update" : "setting.update",
    entityType: "setting",
    entityId: key,
    before: { value: before.value, source: before.source },
    after: { value: parsed.data, version: row.version },
    reason,
  });

  return { key, value: parsed.data, version: row.version, updatedAt: row.updatedAt };
};
