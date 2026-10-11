import type { AdminRole } from "@prisma/client";

/**
 * Every admin capability. Roles are bundles of these; routes ask for these,
 * never for a role. Adding one here means adding it to the roles that need it
 * and to the table in `npm run verify:admin`.
 */
export const ALL_PERMISSIONS = [
  "users.view",
  "users.view_pii",
  "users.manage",
  "users.role",
  "users.delete",
  "users.impersonate",
  "salons.view",
  "salons.review",
  "salons.manage",
  "salons.delete",
  "bookings.view",
  "bookings.manage",
  "appeals.resolve",
  "finance.view",
  "finance.payouts",
  "finance.refunds",
  "finance.wallet_adjust",
  "finance.wallet_freeze",
  "finance.reconcile",
  "finance.export",
  "reviews.moderate",
  "support.view",
  "support.reply",
  "support.assign",
  "content.manage",
  "analytics.view",
  "analytics.export",
  "settings.view",
  "flags.manage",
  "settings.manage",
  "system.view",
  "system.operate",
  "audit.view",
  "agents.manage",
  "team.manage",
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

export const ADMIN_ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  SUPER_ADMIN: ALL_PERMISSIONS,
  OPERATIONS: [
    "users.view",
    "users.view_pii",
    "users.manage",
    "users.role",
    "users.impersonate",
    "salons.view",
    "salons.review",
    "salons.manage",
    "bookings.view",
    "bookings.manage",
    "appeals.resolve",
    "finance.view",
    "finance.reconcile",
    "reviews.moderate",
    "support.view",
    "support.reply",
    "support.assign",
    "content.manage",
    "analytics.view",
    "analytics.export",
    "settings.view",
    "flags.manage",
    "system.view",
    "system.operate",
    "audit.view",
    "agents.manage",
  ],
  FINANCE: [
    "users.view",
    "users.view_pii",
    "salons.view",
    "bookings.view",
    "finance.view",
    "finance.payouts",
    "finance.refunds",
    "finance.wallet_adjust",
    "finance.wallet_freeze",
    "finance.reconcile",
    "finance.export",
    "analytics.view",
    "analytics.export",
    "settings.view",
    "system.view",
    "audit.view",
  ],
  SUPPORT: [
    "users.view",
    "users.view_pii",
    "users.manage",
    "users.impersonate",
    "salons.view",
    "bookings.view",
    "bookings.manage",
    "appeals.resolve",
    "support.view",
    "support.reply",
    "support.assign",
  ],
  MODERATOR: [
    "users.view",
    "users.manage",
    "salons.view",
    "bookings.view",
    "reviews.moderate",
    "support.view",
  ],
  ANALYST: [
    "users.view",
    "salons.view",
    "bookings.view",
    "finance.view",
    "analytics.view",
    "analytics.export",
    "settings.view",
    "system.view",
  ],
};

/** An AGENT is an area-scoped salon reviewer, nothing more. */
export const AGENT_PERMISSIONS: readonly Permission[] = [
  "salons.view",
  "salons.review",
];

export const isPermission = (s: string): s is Permission =>
  (ALL_PERMISSIONS as readonly string[]).includes(s);

export const permissionsFor = (
  accountRole: string,
  adminRole?: AdminRole | null,
): Permission[] => {
  if (accountRole === "ADMIN" && adminRole) {
    return [...ADMIN_ROLE_PERMISSIONS[adminRole]];
  }
  if (accountRole === "AGENT") return [...AGENT_PERMISSIONS];
  return [];
};

export const can = (
  admin: { permissions: readonly Permission[] } | null | undefined,
  permission: Permission,
): boolean => !!admin && admin.permissions.includes(permission);

/** Areas are typed by hand on salons and agents; compare them loosely. */
export const normalizeArea = (s: string): string => s.trim().toLowerCase();
