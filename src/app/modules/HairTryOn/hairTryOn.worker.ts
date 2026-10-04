import { randomUUID } from "crypto";
import config from "../../../config";
import prisma from "../../shared/prisma";
import { findColor, findStyle } from "./hairTryOn.catalog";
import { HairCloudinary } from "./hairTryOn.cloudinary";
import { getProvider, HairEditError } from "./hairTryOn.provider";

const EDIT_TIMEOUT_MS = 60_000;
const SWEEP_INTERVAL_MS = 60_000;
// Past the edit timeout plus the result upload: a RUNNING job this old was
// lost with a process that died mid-run.
const STALE_AFTER_MS = 3 * 60_000;

// In-process queue: jobs live in the database, so a restart loses nothing but
// its place in line (startHairWorker re-enqueues PENDING ones).
const queue: string[] = [];
const queued = new Set<string>();
let running = 0;

const log = (id: string, status: string, latencyMs: number, errorCode = "") =>
  console.log(`[hair] job ${id} ${status} ${latencyMs}ms ${errorCode}`.trim());

/** Finish a job still marked RUNNING; a job the sweep already failed is left alone. */
const fail = async (id: string, startedAt: number, errorCode: string) => {
  const latencyMs = Date.now() - startedAt;
  await prisma.hairTryOnJob.updateMany({
    where: { id, status: "RUNNING" },
    data: { status: "FAILED", errorCode, latencyMs, finishedAt: new Date() },
  });
  log(id, "FAILED", latencyMs, errorCode);
};

const runJob = async (id: string) => {
  // The conditional update is the claim: two workers can't both win it.
  const claimed = await prisma.hairTryOnJob.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "RUNNING", startedAt: new Date() },
  });
  if (claimed.count === 0) return;

  const startedAt = Date.now();
  try {
    const job = await prisma.hairTryOnJob.findUnique({
      where: { id },
      include: { upload: { select: { publicId: true, deletedAt: true } } },
    });
    if (!job || job.upload.deletedAt) {
      return await fail(id, startedAt, "UPLOAD_DELETED");
    }

    const style = findStyle(job.styleId);
    const color = findColor(job.colorId);
    if (!style || !color) return await fail(id, startedAt, "PROVIDER_ERROR");

    const result = await getProvider().edit({
      publicId: job.upload.publicId,
      style,
      color,
      signal: AbortSignal.timeout(EDIT_TIMEOUT_MS),
    });

    const resultPublicId = `hair-tryon/results/${randomUUID()}`;
    await HairCloudinary.uploadBuffer(result.image, resultPublicId);

    const latencyMs = Date.now() - startedAt;
    const done = await prisma.hairTryOnJob.updateMany({
      where: { id, status: "RUNNING", upload: { deletedAt: null } },
      data: {
        status: "DONE",
        resultPublicId,
        model: result.model,
        latencyMs,
        finishedAt: new Date(),
      },
    });

    if (done.count === 0) {
      // Swept as stale, or the photo was deleted mid-run: don't keep the result.
      await HairCloudinary.deleteAssets([resultPublicId]);
      return await fail(id, startedAt, "UPLOAD_DELETED");
    }
    log(id, "DONE", latencyMs);
  } catch (error) {
    await fail(
      id,
      startedAt,
      error instanceof HairEditError ? error.code : "PROVIDER_ERROR",
    );
  }
};

const pump = () => {
  const limit = Math.max(1, config.hairTryOn.concurrency);
  while (running < limit && queue.length > 0) {
    const id = queue.shift() as string;
    queued.delete(id);
    running++;
    runJob(id)
      .catch(() => log(id, "ERROR", 0))
      .finally(() => {
        running--;
        pump();
      });
  }
};

export const enqueueHairJob = (id: string) => {
  if (queued.has(id)) return;
  queued.add(id);
  queue.push(id);
  pump();
};

const sweepStaleJobs = async () => {
  const swept = await prisma.hairTryOnJob.updateMany({
    where: {
      status: "RUNNING",
      startedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) },
    },
    data: { status: "FAILED", errorCode: "TIMEOUT", finishedAt: new Date() },
  });
  if (swept.count > 0) console.log(`[hair] swept ${swept.count} stale job(s)`);
};

export const startHairWorker = async () => {
  if (process.env.DISABLE_BACKGROUND_JOBS === "true") return;

  const sweep = () =>
    sweepStaleJobs().catch(() => console.error("[hair] stale sweep failed"));

  setInterval(sweep, SWEEP_INTERVAL_MS).unref();
  await sweep();

  const pending = await prisma.hairTryOnJob.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  pending.forEach((job) => enqueueHairJob(job.id));
};
