import { v2 as cloudinary } from "cloudinary";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import config from "../../../config";
import prisma from "../../shared/prisma";
import { AccessUser, assertOwnerOf, assertSalonPermission } from "../../utils/salonAccess";

// Salon photos are public: the browser uploads them straight to Cloudinary with
// a ticket signed here, then the photo's URL is saved in `Salon.images` through
// PATCH /salons/:id. The signature pins the folder, formats and an incoming
// size limit, so a ticket can't be reused to put anything else in the account.

cloudinary.config({
  cloud_name: config.cloudinary.cloud_name,
  api_key: config.cloudinary.api_key,
  api_secret: config.cloudinary.api_secret,
  secure: true,
});

/** How many photos a salon keeps; the first is the cover. */
export const SALON_MAX_IMAGES = 10;
export const SALON_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const SALON_IMAGE_FORMATS = ["jpg", "jpeg", "png", "webp"];
// Cloudinary accepts a signature for an hour; the ticket we hand out says 10 minutes.
const UPLOAD_TICKET_MS = 10 * 60 * 1000;
const ROOT = "salons";

/** Where a branch's photos live; also the only prefix `destroyRemovedPhotos` touches. */
const folderOf = (salonId: string) => `${ROOT}/${salonId}`;

const configured = () =>
  Boolean(config.cloudinary.cloud_name && config.cloudinary.api_key && config.cloudinary.api_secret);

const ticket = (folder: string) => {
  if (!configured()) {
    throw new ApiError(StatusCodes.SERVICE_UNAVAILABLE, "Photo uploads are not available right now.");
  }
  const params = {
    folder,
    timestamp: Math.round(Date.now() / 1000),
    allowed_formats: SALON_IMAGE_FORMATS.join(","),
    // Incoming transformation: nothing larger than 1920 px is ever stored.
    transformation: "c_limit,w_1920,h_1920",
    tags: "salon-photo",
  };
  const signature = cloudinary.utils.api_sign_request(params, config.cloudinary.api_secret as string);
  return {
    cloudName: config.cloudinary.cloud_name as string,
    apiKey: config.cloudinary.api_key as string,
    uploadUrl: `https://api.cloudinary.com/v1_1/${config.cloudinary.cloud_name}/image/upload`,
    params: { ...params, signature },
    expiresAt: new Date(params.timestamp * 1000 + UPLOAD_TICKET_MS),
    maxBytes: SALON_IMAGE_MAX_BYTES,
    maxImages: SALON_MAX_IMAGES,
    formats: SALON_IMAGE_FORMATS,
  };
};

/** POST /salons/:id/photo-upload-signature (branch.profile at this branch). */
const photoUploadSignature = async (user: AccessUser, salonId: string) => {
  await assertSalonPermission(user, salonId, "branch.profile");
  return ticket(folderOf(salonId));
};

/** POST /salons/photo-upload-signature: photos for a salon that doesn't exist yet (Add salon). */
const newSalonPhotoUploadSignature = async (user: AccessUser) => {
  const { ownerId } = await assertOwnerOf(user);
  return ticket(`${ROOT}/new/${ownerId}`);
};

/**
 * The Cloudinary public id of a photo this branch uploaded, or null for
 * anything else (a pasted link, another folder, another cloud).
 */
const ownPublicId = (salonId: string, url: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "res.cloudinary.com") return null;
  const prefix = `/${config.cloudinary.cloud_name}/image/upload/`;
  if (!parsed.pathname.startsWith(prefix)) return null;
  // What follows /upload/ is an optional version ("v123/") then the public id.
  const rest = decodeURIComponent(parsed.pathname.slice(prefix.length)).replace(/^v\d+\//, "");
  if (!rest.startsWith(`${folderOf(salonId)}/`)) return null;
  return rest.replace(/\.[a-z0-9]+$/i, "");
};

/**
 * Best effort, after the save: photos dropped from a branch's list are deleted
 * from Cloudinary when they are in that branch's own folder. Pasted links and
 * photos still listed are never touched. A failure only leaves an orphan.
 */
const destroyRemovedPhotos = (salonId: string, before: string[], after: string[]) => {
  if (!configured()) return;
  const kept = new Set(after);
  const ids = before
    .filter((url) => !kept.has(url))
    .map((url) => ownPublicId(salonId, url))
    .filter((id): id is string => !!id);
  if (!ids.length) return;
  cloudinary.api
    .delete_resources(ids, { type: "upload", resource_type: "image" })
    .catch((err: unknown) => console.error("[salon.photos] could not delete removed photos", err));
};

/**
 * POST /salons/:id/photo-uploads/discard (branch.profile): the owner uploaded
 * photos into the Photos draft and then discarded them (or removed them before
 * saving). Deletes the ones in this branch's folder that the salon doesn't
 * list; anything still on the salon page is left alone.
 */
const discardUploads = async (user: AccessUser, salonId: string, urls: string[]) => {
  await assertSalonPermission(user, salonId, "branch.profile");
  const salon = await prisma.salon.findFirst({
    where: { id: salonId, isDeleted: false },
    select: { images: true },
  });
  if (!salon) throw new ApiError(StatusCodes.NOT_FOUND, "Salon not found");
  destroyRemovedPhotos(salonId, urls, salon.images);
  return null;
};

export const SalonPhotos = {
  photoUploadSignature,
  newSalonPhotoUploadSignature,
  destroyRemovedPhotos,
  discardUploads,
};
