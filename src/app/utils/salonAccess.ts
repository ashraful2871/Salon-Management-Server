import { BranchRole, Prisma, UserRole } from "@prisma/client";
import type { Request } from "express";
import { StatusCodes } from "http-status-codes";
import ApiError from "../Error/error";
import prisma from "../shared/prisma";

/**
 * The one place that decides "may this user do X at branch Y". Every owner,
 * team member, staff and admin check on a salon's data goes through here; a
 * refusal is a 404 so another business's ids look like ids that do not exist.
 */

export type OwnerPermission =
  | "bookings.view"
  | "bookings.manage"
  | "walkin.create"
  | "close.manage"
  | "customers.view"
  | "slots.manage"
  | "counters.manage"
  | "services.toggle"
  | "services.edit"
  | "team.invite"
  | "team.invite_manager"
  | "reviews.reply"
  | "reports.view"
  | "branch.profile"
  | "branch.location"
  | "policy.manage"
  | "money.view"
  | "branch.create"
  | "activity.view";

export const OWNER_PERMISSIONS: OwnerPermission[] = [
  "bookings.view",
  "bookings.manage",
  "walkin.create",
  "close.manage",
  "customers.view",
  "slots.manage",
  "counters.manage",
  "services.toggle",
  "services.edit",
  "team.invite",
  "team.invite_manager",
  "reviews.reply",
  "reports.view",
  "branch.profile",
  "branch.location",
  "policy.manage",
  "money.view",
  "branch.create",
  "activity.view",
];

/** What each team role may do at its branch. A STYLIST sees and works only their own bookings. */
export const ROLE_PERMISSIONS: Record<BranchRole, OwnerPermission[]> = {
  MANAGER: [
    "bookings.view",
    "bookings.manage",
    "walkin.create",
    "close.manage",
    "customers.view",
    "slots.manage",
    "counters.manage",
    "services.toggle",
    "team.invite",
    "reviews.reply",
    "reports.view",
    "branch.profile",
    "activity.view",
  ],
  RECEPTIONIST: ["bookings.view", "bookings.manage", "walkin.create", "close.manage", "customers.view"],
  STYLIST: ["bookings.view", "bookings.manage"],
};

/** Owner-only, whatever a member's role says. */
export const OWNER_ONLY_PERMISSIONS: OwnerPermission[] = [
  "money.view",
  "policy.manage",
  "branch.location",
  "branch.create",
  "team.invite_manager",
];

/**
 * A STAFF account with no salon_members row at its salon (not backfilled):
 * the same as before the team phase, walk-ins included.
 */
const STAFF_PERMISSIONS: OwnerPermission[] = [
  "walkin.create",
  "bookings.view",
  "bookings.manage",
  "customers.view",
];

/** Every account type that can work at a branch; services decide with `assertSalonPermission`. */
export const BUSINESS_ROLES = [UserRole.SALON_OWNER, UserRole.BRANCH_MANAGER, UserRole.STAFF] as const;

export const isBusinessRole = (role: string) => (BUSINESS_ROLES as readonly string[]).includes(role);

type AccessCache = Map<string, Promise<unknown>>;
/** `db`: read through this client instead (a script's rolled-back transaction). */
export type AccessUser = { userId: string; role: string; cache?: AccessCache; db?: Prisma.TransactionClient };

const requestCaches = new WeakMap<Request, AccessCache>();

/** The signed-in user with a lookup memo that lives as long as this request. */
export const withAccessCache = (req: Request): AccessUser => {
  let cache = requestCaches.get(req);
  if (!cache) {
    cache = new Map();
    requestCaches.set(req, cache);
  }
  return { userId: req.user?.userId, role: req.user?.role, cache };
};

const memo = <T>(user: AccessUser, key: string, load: () => Promise<T>): Promise<T> => {
  if (!user.cache) return load();
  const hit = user.cache.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const pending = load();
  user.cache.set(key, pending);
  return pending;
};

const notFound = () => new ApiError(StatusCodes.NOT_FOUND, "Not found");

const loadOwner = (user: AccessUser) =>
  memo(user, `owner:${user.userId}`, () =>
    (user.db ?? prisma).salonOwner.findUnique({
      where: { userId: user.userId },
      select: {
        id: true,
        salons: {
          where: { isDeleted: false },
          select: { id: true, name: true },
          orderBy: { createdAt: "asc" },
        },
      },
    }),
  );

export type AccessRole = "OWNER" | BranchRole | "STAFF";

/** One branch the user works at. `ownBookingsOnly`: bookings are limited to `staffId`. */
export type Grant = {
  salonId: string;
  salonName: string;
  role: AccessRole;
  permissions: OwnerPermission[];
  ownBookingsOnly: boolean;
  staffId: string | null;
};

/**
 * Every branch this user works at, owned ones first. The owner holds
 * everything at their live salons; an ACTIVE member holds their role's set at
 * a live salon (never an owner-only permission); a STAFF account with no
 * member row at its salon keeps the pre-team set. SUSPENDED and REMOVED rows
 * grant nothing.
 */
const loadGrants = (user: AccessUser) =>
  memo(user, `grants:${user.userId}`, async (): Promise<Grant[]> => {
    if (!user.userId) return [];
    const db = user.db ?? prisma;
    const [owner, members, staff] = await Promise.all([
      user.role === UserRole.SALON_OWNER ? loadOwner(user) : null,
      db.salonMember.findMany({
        where: { userId: user.userId },
        select: {
          salonId: true,
          role: true,
          status: true,
          salon: { select: { name: true, isDeleted: true, managerCanEditServices: true } },
        },
        orderBy: { createdAt: "asc" },
      }),
      db.staff.findUnique({
        where: { userId: user.userId },
        select: {
          id: true,
          salonId: true,
          isDeleted: true,
          salon: { select: { name: true, isDeleted: true } },
        },
      }),
    ]);

    const grants = new Map<string, Grant>();
    for (const salon of owner?.salons ?? []) {
      grants.set(salon.id, {
        salonId: salon.id,
        salonName: salon.name,
        role: "OWNER",
        permissions: [...OWNER_PERMISSIONS],
        ownBookingsOnly: false,
        staffId: null,
      });
    }

    const liveStaffId = (salonId: string) =>
      staff && !staff.isDeleted && staff.salonId === salonId ? staff.id : null;

    for (const member of members) {
      if (member.status !== "ACTIVE" || member.salon.isDeleted || grants.has(member.salonId)) continue;
      const permissions = ROLE_PERMISSIONS[member.role].filter((p) => !OWNER_ONLY_PERMISSIONS.includes(p));
      if (member.role === "MANAGER" && member.salon.managerCanEditServices) permissions.push("services.edit");
      grants.set(member.salonId, {
        salonId: member.salonId,
        salonName: member.salon.name,
        role: member.role,
        permissions,
        ownBookingsOnly: member.role === "STYLIST",
        staffId: liveStaffId(member.salonId),
      });
    }

    if (
      user.role === UserRole.STAFF &&
      staff &&
      !staff.isDeleted &&
      !staff.salon.isDeleted &&
      !grants.has(staff.salonId) &&
      !members.some((member) => member.salonId === staff.salonId)
    ) {
      grants.set(staff.salonId, {
        salonId: staff.salonId,
        salonName: staff.salon.name,
        role: "STAFF",
        permissions: [...STAFF_PERMISSIONS],
        ownBookingsOnly: true,
        staffId: staff.id,
      });
    }

    return [...grants.values()];
  });

/** The user's grant at one branch, or null. Admins have none (they hold everything). */
export const grantAt = async (user: AccessUser, salonId: string): Promise<Grant | null> =>
  (await loadGrants(user)).find((grant) => grant.salonId === salonId) ?? null;

/**
 * The salons where this user holds `perm`: `null` for an admin (every salon),
 * otherwise the branches whose grant includes it.
 */
export const accessibleSalonIds = async (
  user: AccessUser,
  perm: OwnerPermission,
): Promise<string[] | null> => {
  if (user.role === UserRole.ADMIN) return null;
  return (await loadGrants(user))
    .filter((grant) => grant.permissions.includes(perm))
    .map((grant) => grant.salonId);
};

const asList = (requested?: string | string[]) =>
  (Array.isArray(requested) ? requested : requested ? [requested] : []).filter(Boolean);

/**
 * `accessibleSalonIds` narrowed to the salon(s) the caller asked for. Asking
 * for a salon outside the set leaves nothing - callers answer with an empty
 * page, never an error.
 */
export const scopeSalonIds = async (
  user: AccessUser,
  perm: OwnerPermission,
  requested?: string | string[],
): Promise<string[] | null> => {
  const allowed = await accessibleSalonIds(user, perm);
  const wanted = asList(requested);
  if (!wanted.length) return allowed;
  if (allowed === null) return wanted;
  if (wanted.some((id) => !allowed.includes(id))) return [];
  return wanted;
};

/** Throws 404 unless the user holds `perm` at `salonId`. */
export const assertSalonPermission = async (
  user: AccessUser,
  salonId: string,
  perm: OwnerPermission,
): Promise<void> => {
  const allowed = await accessibleSalonIds(user, perm);
  if (allowed === null) return;
  if (!salonId || !allowed.includes(salonId)) throw notFound();
};

/**
 * The appointments this user may see with `perm`, as a Prisma filter: `{}`
 * for an admin, `null` for nothing (also when a salon outside their set is
 * asked for). A stylist's branch adds only the stylist's own bookings.
 */
export const bookingScopeWhere = async (
  user: AccessUser,
  perm: OwnerPermission,
  requested?: string | string[],
): Promise<Prisma.AppointmentWhereInput | null> => {
  const wanted = asList(requested);
  if (user.role === UserRole.ADMIN) return wanted.length ? { salonId: { in: wanted } } : {};

  const grants = (await loadGrants(user)).filter((grant) => grant.permissions.includes(perm));
  if (wanted.some((id) => !grants.some((grant) => grant.salonId === id))) return null;
  const inScope = wanted.length ? grants.filter((grant) => wanted.includes(grant.salonId)) : grants;

  const whole = inScope.filter((grant) => !grant.ownBookingsOnly).map((grant) => grant.salonId);
  const parts: Prisma.AppointmentWhereInput[] = whole.length ? [{ salonId: { in: whole } }] : [];
  for (const grant of inScope) {
    if (grant.ownBookingsOnly && grant.staffId) {
      parts.push({ salonId: grant.salonId, staffId: grant.staffId });
    }
  }
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : { OR: parts };
};

/** Throws 404 unless the user holds `perm` for this booking (a stylist: only their own). */
export const assertBookingPermission = async (
  user: AccessUser,
  booking: { salonId: string; staffId?: string | null },
  perm: OwnerPermission,
): Promise<void> => {
  if (user.role === UserRole.ADMIN) return;
  const grant = await grantAt(user, booking.salonId);
  if (!grant || !grant.permissions.includes(perm)) throw notFound();
  if (grant.ownBookingsOnly && (!grant.staffId || booking.staffId !== grant.staffId)) throw notFound();
};

/** `assertBookingPermission` as a boolean. */
export const canSeeBooking = (
  user: AccessUser,
  booking: { salonId: string; staffId?: string | null },
  perm: OwnerPermission = "bookings.view",
) => assertBookingPermission(user, booking, perm).then(() => true, () => false);

/** The caller's owner profile; 404 when they are not a salon owner. */
export const assertOwnerOf = async (
  user: AccessUser,
): Promise<{ ownerId: string; salonIds: string[] }> => {
  if (user.role !== UserRole.SALON_OWNER) throw notFound();
  const owner = await loadOwner(user);
  if (!owner) throw notFound();
  return { ownerId: owner.id, salonIds: owner.salons.map((salon) => salon.id) };
};

export type SalonAccess = {
  salonId: string;
  salonName: string;
  role: AccessRole;
  permissions: OwnerPermission[];
};

/** Every branch the user works at, their role there and what they may do. */
export const getMyAccess = async (user: AccessUser): Promise<SalonAccess[]> =>
  (await loadGrants(user)).map(({ salonId, salonName, role, permissions }) => ({
    salonId,
    salonName,
    role,
    permissions: [...permissions],
  }));

/** The owner's live salons; empty if they have no owner profile. */
export const ownedSalonIds = async (userId: string) =>
  ((await loadOwner({ userId, role: UserRole.SALON_OWNER }))?.salons ?? []).map((salon) => salon.id);

/** Whether this user may act on a booking (bookings.manage); 404 otherwise. */
export const assertCanActOnAppointment = (
  userId: string,
  userRole: string,
  booking: { salonId: string; staffId?: string | null },
) => assertBookingPermission({ userId, role: userRole }, booking, "bookings.manage");
