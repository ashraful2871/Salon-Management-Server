import { Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { BD_BOUNDS } from "../Salon/salon.validation";
import type { Actor } from "./home.booking";
import type { AddressBody } from "./home.validation";

/**
 * A customer's saved home-visit addresses (`/home-service/addresses`). Only a
 * convenience for the booking form: a booking copies the address into its own
 * columns, so editing or deleting one here never touches a visit. Someone
 * else's address answers 404.
 */

const MAX_ADDRESSES = 10;

const SELECT = {
  id: true,
  label: true,
  addressLine: true,
  area: true,
  landmark: true,
  latitude: true,
  longitude: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CustomerAddressSelect;

const notFound = () => new ApiError(StatusCodes.NOT_FOUND, "Address not found");
const readOnly = () =>
  ApiError.withCode(StatusCodes.FORBIDDEN, "Read-only view: changes are not allowed while viewing as this user.", "IMPERSONATION_READ_ONLY");

const assertInBd = (lat: number, lng: number) => {
  if (lat < BD_BOUNDS.minLat || lat > BD_BOUNDS.maxLat || lng < BD_BOUNDS.minLng || lng > BD_BOUNDS.maxLng) {
    throw ApiError.withCode(StatusCodes.BAD_REQUEST, "Pick a location inside Bangladesh.", "INVALID_LOCATION");
  }
};

const fieldsOf = (body: Partial<AddressBody>) => ({
  ...(body.label !== undefined ? { label: body.label } : {}),
  ...(body.addressLine !== undefined ? { addressLine: body.addressLine } : {}),
  ...(body.area !== undefined ? { area: body.area || null } : {}),
  ...(body.landmark !== undefined ? { landmark: body.landmark || null } : {}),
  ...(body.latitude !== undefined ? { latitude: body.latitude } : {}),
  ...(body.longitude !== undefined ? { longitude: body.longitude } : {}),
});

const order = [{ isDefault: "desc" }, { updatedAt: "desc" }] satisfies Prisma.CustomerAddressOrderByWithRelationInput[];

export const listAddresses = (userId: string) =>
  prisma.customerAddress.findMany({ where: { userId }, select: SELECT, orderBy: order });

/** The first address is the default; `isDefault: true` moves the default here. */
export const createAddress = async (actor: Actor, body: AddressBody) => {
  if (actor.impersonating) throw readOnly();
  assertInBd(body.latitude, body.longitude);
  return prisma.$transaction(async (tx) => {
    const count = await tx.customerAddress.count({ where: { userId: actor.userId } });
    if (count >= MAX_ADDRESSES) {
      throw new ApiError(StatusCodes.BAD_REQUEST, `You can save up to ${MAX_ADDRESSES} addresses. Remove one first.`);
    }
    const isDefault = count === 0 || body.isDefault === true;
    if (isDefault) await tx.customerAddress.updateMany({ where: { userId: actor.userId }, data: { isDefault: false } });
    return tx.customerAddress.create({
      data: {
        userId: actor.userId,
        label: body.label,
        addressLine: body.addressLine,
        area: body.area || null,
        landmark: body.landmark || null,
        latitude: body.latitude,
        longitude: body.longitude,
        isDefault,
      },
      select: SELECT,
    });
  });
};

export const updateAddress = async (actor: Actor, id: string, body: Partial<AddressBody>) => {
  if (actor.impersonating) throw readOnly();
  const before = await prisma.customerAddress.findFirst({ where: { id, userId: actor.userId } });
  if (!before) throw notFound();
  assertInBd(body.latitude ?? before.latitude, body.longitude ?? before.longitude);
  return prisma.$transaction(async (tx) => {
    // The default only moves: turning it off would leave none.
    if (body.isDefault === true) await tx.customerAddress.updateMany({ where: { userId: actor.userId }, data: { isDefault: false } });
    return tx.customerAddress.update({
      where: { id },
      data: { ...fieldsOf(body), ...(body.isDefault === true ? { isDefault: true } : {}) },
      select: SELECT,
    });
  });
};

/** Removing the default hands it to the most recently used address left. */
export const deleteAddress = async (actor: Actor, id: string) => {
  if (actor.impersonating) throw readOnly();
  return prisma.$transaction(async (tx) => {
    const row = await tx.customerAddress.findFirst({ where: { id, userId: actor.userId }, select: { id: true, isDefault: true } });
    if (!row) throw notFound();
    await tx.customerAddress.delete({ where: { id } });
    if (row.isDefault) {
      const next = await tx.customerAddress.findFirst({ where: { userId: actor.userId }, orderBy: { updatedAt: "desc" }, select: { id: true } });
      if (next) await tx.customerAddress.update({ where: { id: next.id }, data: { isDefault: true } });
    }
    return { id };
  });
};
