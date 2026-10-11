import { UserRole } from "@prisma/client";
import type { Request } from "express";
import { StatusCodes } from "http-status-codes";
import ApiError from "../Error/error";
import prisma from "../shared/prisma";

/**
 * The one place that decides "may this user do X at branch Y". Every owner,
 * staff and admin check on a salon's data goes through here; a refusal is a
 * 404 so another business's ids look like ids that do not exist.
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

/** What STAFF may do at the salon they work for - the same as before Phase 1 (walk-ins included). */
const STAFF_PERMISSIONS: OwnerPermission[] = [
  "walkin.create",
  "bookings.view",
  "bookings.manage",
  "customers.view",
];

export const BUSINESS_ROLES = [UserRole.SALON_OWNER, UserRole.STAFF] as const;

type AccessCache = Map<string, Promise<unknown>>;
export type AccessUser = { userId: string; role: string; cache?: AccessCache };

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
    prisma.salonOwner.findUnique({
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

const loadStaff = (user: AccessUser) =>
  memo(user, `staff:${user.userId}`, () =>
    prisma.staff.findUnique({
      where: { userId: user.userId },
      select: { salonId: true, isDeleted: true, salon: { select: { name: true } } },
    }),
  );

/**
 * The salons where this user holds `perm`: `null` for an admin (every salon),
 * the owner's live salons, the staff member's salon for the booking
 * permissions, otherwise none.
 */
export const accessibleSalonIds = async (
  user: AccessUser,
  perm: OwnerPermission,
): Promise<string[] | null> => {
  if (user.role === UserRole.ADMIN) return null;

  if (user.role === UserRole.SALON_OWNER) {
    const owner = await loadOwner(user);
    return owner ? owner.salons.map((salon) => salon.id) : [];
  }

  if (user.role === UserRole.STAFF && STAFF_PERMISSIONS.includes(perm)) {
    const staff = await loadStaff(user);
    return staff && !staff.isDeleted ? [staff.salonId] : [];
  }

  return [];
};

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
  const wanted = (Array.isArray(requested) ? requested : requested ? [requested] : []).filter(Boolean);
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
  role: "OWNER" | "STAFF";
  permissions: OwnerPermission[];
};

/** Every branch the user works at and what they may do there. */
export const getMyAccess = async (user: AccessUser): Promise<SalonAccess[]> => {
  if (user.role === UserRole.SALON_OWNER) {
    const owner = await loadOwner(user);
    return (owner?.salons ?? []).map((salon) => ({
      salonId: salon.id,
      salonName: salon.name,
      role: "OWNER" as const,
      permissions: [...OWNER_PERMISSIONS],
    }));
  }

  if (user.role === UserRole.STAFF) {
    const staff = await loadStaff(user);
    if (!staff || staff.isDeleted) return [];
    return [
      {
        salonId: staff.salonId,
        salonName: staff.salon.name,
        role: "STAFF",
        permissions: [...STAFF_PERMISSIONS],
      },
    ];
  }

  return [];
};

/** The owner's live salons; empty if they have no owner profile. */
export const ownedSalonIds = async (userId: string) =>
  (await accessibleSalonIds({ userId, role: UserRole.SALON_OWNER }, "bookings.manage")) ?? [];

/** Whether this user may act on a booking at `salonId` (bookings.manage); 404 otherwise. */
export const assertCanActOnAppointment = (userId: string, userRole: string, salonId: string) =>
  assertSalonPermission({ userId, role: userRole }, salonId, "bookings.manage");
