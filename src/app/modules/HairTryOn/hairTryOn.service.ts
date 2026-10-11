import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { StatusCodes } from "http-status-codes";
import config from "../../../config";
import ApiError from "../../Error/error";
import { HairTryOnUpload, Prisma } from "@prisma/client";
import { TransformationOptions } from "cloudinary";
import prisma from "../../shared/prisma";
import { getSetting } from "../../utils/settings";
import { findColor, findStyle, publicCatalog } from "./hairTryOn.catalog";
import { HairCloudinary } from "./hairTryOn.cloudinary";
import { getProvider } from "./hairTryOn.provider";
import { verifyTurnstile } from "./hairTryOn.turnstile";
import { enqueueHairJob } from "./hairTryOn.worker";

const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_SHORT_SIDE = 400;
// The upload preset can't carry max_file_size (the Admin API drops it).
const MAX_BYTES = 10 * 1024 * 1024;

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const notFound = () =>
  new ApiError(StatusCodes.NOT_FOUND, "This photo is no longer available.");

/**
 * The upload, if `token` owns it. Missing, deleted, expired and wrong-token all
 * answer the same 404, so a guessed id never confirms it exists.
 */
const assertOwned = <T extends HairTryOnUpload>(
  upload: T | null | undefined,
  token: string | undefined,
): T => {
  if (!upload || upload.deletedAt || upload.expiresAt <= new Date() || !token) {
    throw notFound();
  }

  const given = Buffer.from(sha256(token), "hex");
  const stored = Buffer.from(upload.ownerTokenHash, "hex");
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) {
    throw notFound();
  }

  return upload;
};

const findOwnedUpload = async (id: string, token: string | undefined) =>
  assertOwned(await prisma.hairTryOnUpload.findUnique({ where: { id } }), token);

const DISPLAY: TransformationOptions[] = [
  { crop: "limit", width: 1024, fetch_format: "auto", quality: "auto" },
];
// The download carries a visible "AI preview" mark; the on-screen result doesn't.
const WATERMARK: TransformationOptions[] = [
  ...DISPLAY,
  {
    overlay: {
      font_family: "Arial",
      font_size: 28,
      text: "AI preview · SalonKhuji",
    },
    color: "#ffffff",
    opacity: 70,
    gravity: "south_east",
    x: 20,
    y: 20,
  },
  { flags: "attachment" },
];

const beforeUrl = (publicId: string) =>
  HairCloudinary.signedUrl(publicId, DISPLAY);

// The hairTryOn.enabled platform setting (env HAIR_TRYON_ENABLED).
const assertEnabled = async () => {
  if (!(await getSetting("hairTryOn.enabled"))) {
    throw new ApiError(
      StatusCodes.SERVICE_UNAVAILABLE,
      "Try-on is resting right now",
    );
  }
};

const getStyles = async () => ({
  enabled: await getSetting("hairTryOn.enabled"),
  ...publicCatalog(),
});

const createUpload = async (turnstileToken: string, ip: string) => {
  await assertEnabled();

  if (!(await verifyTurnstile(turnstileToken, ip))) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "We couldn't verify you're human. Please try again.",
    );
  }

  const ownerToken = randomBytes(32).toString("hex");
  const publicId = `hair-tryon/originals/${randomUUID()}`;

  const upload = await prisma.hairTryOnUpload.create({
    data: {
      ownerTokenHash: sha256(ownerToken),
      clientKey: sha256(ip),
      publicId,
      expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
    },
  });

  return {
    uploadId: upload.id,
    ownerToken,
    ...HairCloudinary.signUpload(publicId),
  };
};

/** Delete the rejected original, retire the row and build the 422. */
const rejectPhoto = async (id: string, publicId: string, message: string) => {
  await HairCloudinary.deleteAssets([publicId]);
  await prisma.hairTryOnUpload.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  return new ApiError(StatusCodes.UNPROCESSABLE_ENTITY, message);
};

const confirmUpload = async (
  id: string,
  token: string | undefined,
  version: number | string,
  signature: string,
) => {
  const upload = await findOwnedUpload(id, token);

  // A retried confirm after success needs no second Admin API call.
  if (upload.confirmed) return { beforeUrl: beforeUrl(upload.publicId) };

  if (!HairCloudinary.verifyUpload(upload.publicId, version, signature)) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "We couldn't verify this upload. Please upload the photo again.",
    );
  }

  let info: Awaited<ReturnType<typeof HairCloudinary.getUploadInfo>>;
  try {
    info = await HairCloudinary.getUploadInfo(upload.publicId);
  } catch (error) {
    const httpCode = (error as { error?: { http_code?: number } })?.error
      ?.http_code;
    if (httpCode === 404) {
      throw new ApiError(
        StatusCodes.BAD_REQUEST,
        "We didn't receive the photo. Please upload it again.",
      );
    }
    throw error;
  }

  if (info.faceCount === 0) {
    throw await rejectPhoto(
      id,
      upload.publicId,
      "We couldn't find a face. Try a clear, front-facing photo.",
    );
  }
  if (info.faceCount > 1) {
    throw await rejectPhoto(
      id,
      upload.publicId,
      "Please use a photo with only one person.",
    );
  }
  if (Math.min(info.width, info.height) < MIN_SHORT_SIDE) {
    throw await rejectPhoto(id, upload.publicId, "This photo is too small.");
  }
  if (info.bytes > MAX_BYTES) {
    throw await rejectPhoto(id, upload.publicId, "This photo is too large.");
  }

  await prisma.hairTryOnUpload.update({
    where: { id },
    data: {
      width: info.width,
      height: info.height,
      bytes: info.bytes,
      confirmed: true,
    },
  });

  return { beforeUrl: beforeUrl(upload.publicId) };
};

const deleteUpload = async (id: string, token: string | undefined) => {
  const upload = await findOwnedUpload(id, token);
  const jobs = await prisma.hairTryOnJob.findMany({
    where: { uploadId: id, resultPublicId: { not: null } },
    select: { resultPublicId: true },
  });

  await HairCloudinary.deleteAssets([
    upload.publicId,
    ...jobs.map((job) => job.resultPublicId as string),
  ]);
  await prisma.hairTryOnUpload.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
};

type JobRequest = { uploadId: string; styleId: string; colorId: string };

/** Everything a job request must pass before it may cost anything. */
const checkJobRequest = async (
  { uploadId, styleId, colorId }: JobRequest,
  token: string | undefined,
) => {
  await assertEnabled();
  if (!findStyle(styleId) || !findColor(colorId)) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Unknown style or color.");
  }

  const upload = await findOwnedUpload(uploadId, token);
  if (!upload.confirmed) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "Please finish uploading the photo first.",
    );
  }
};

const findJob = ({ uploadId, styleId, colorId }: JobRequest) =>
  prisma.hairTryOnJob.findUnique({
    where: { uploadId_styleId_colorId: { uploadId, styleId, colorId } },
  });

/**
 * The same photo + style + color already queued, running or done. The route
 * answers with it before the generation limiters, so a repeat costs nothing.
 */
const findReusableJob = async (
  request: JobRequest,
  token: string | undefined,
) => {
  await checkJobRequest(request, token);
  const job = await findJob(request);
  return job && job.status !== "FAILED"
    ? { jobId: job.id, status: job.status }
    : null;
};

const startOfTodayUtc = () => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
};

const createJob = async (request: JobRequest, token: string | undefined) => {
  await checkJobRequest(request, token);

  const existing = await findJob(request);
  if (existing && existing.status !== "FAILED") {
    return { jobId: existing.id, status: existing.status };
  }

  const today = await prisma.hairTryOnJob.count({
    where: { createdAt: { gte: startOfTodayUtc() } },
  });
  if (today >= (await getSetting("hairTryOn.dailyCap"))) {
    throw new ApiError(
      StatusCodes.TOO_MANY_REQUESTS,
      "Try-on is resting for today, come back tomorrow.",
    );
  }

  const provider = getProvider().name;
  let jobId: string;

  if (existing) {
    // "Try again": the failed job goes back in line, counted as today's.
    const reset = await prisma.hairTryOnJob.updateMany({
      where: { id: existing.id, status: "FAILED" },
      data: {
        status: "PENDING",
        provider,
        errorCode: null,
        model: null,
        latencyMs: null,
        startedAt: null,
        finishedAt: null,
        createdAt: new Date(),
      },
    });
    if (reset.count === 0) {
      const current = await findJob(request);
      return { jobId: existing.id, status: current?.status ?? "PENDING" };
    }
    jobId = existing.id;
  } else {
    try {
      const job = await prisma.hairTryOnJob.create({
        data: { ...request, provider },
      });
      jobId = job.id;
    } catch (error) {
      // A double-click raced us to the unique key: answer with that job.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const raced = await findJob(request);
        if (raced) return { jobId: raced.id, status: raced.status };
      }
      throw error;
    }
  }

  enqueueHairJob(jobId);
  return { jobId, status: "PENDING" as const };
};

const getJob = async (id: string, token: string | undefined) => {
  const job = await prisma.hairTryOnJob.findUnique({
    where: { id },
    include: { upload: true },
  });
  if (!job) throw notFound();
  const upload = assertOwned(job.upload, token);

  const result =
    job.status === "DONE" && job.resultPublicId
      ? {
          resultUrl: HairCloudinary.signedUrl(job.resultPublicId, DISPLAY),
          downloadUrl: HairCloudinary.signedUrl(job.resultPublicId, WATERMARK),
        }
      : {};

  return {
    status: job.status,
    errorCode: job.errorCode,
    styleId: job.styleId,
    colorId: job.colorId,
    beforeUrl: beforeUrl(upload.publicId),
    ...result,
  };
};

export const HairTryOnService = {
  getStyles,
  createUpload,
  confirmUpload,
  deleteUpload,
  findReusableJob,
  createJob,
  getJob,
};
