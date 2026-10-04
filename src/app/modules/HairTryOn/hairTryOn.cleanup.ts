import { v2 as cloudinary } from "cloudinary";
import prisma from "../../shared/prisma";
import { HairCloudinary } from "./hairTryOn.cloudinary";

// "Your photo is deleted within 24 hours" is a promise on the home page and in
// the privacy note. These two jobs keep it without anyone pressing a button.
// Both log counts only, never a public id or URL.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const PURGE_BATCH = 200;
const ROW_KEEP_MS = 30 * DAY;
const SWEEP_MAX_AGE_MS = 48 * HOUR;
const SWEEP_PAGE_SIZE = 500;

/**
 * Delete expired photos and their results from Cloudinary, mark the uploads
 * deleted, then drop rows older than 30 days (jobs go with them by cascade).
 * The row stays for a while after the photo is gone so the daily cap and the
 * reuse check still have their history.
 */
export const purgeHairTryOn = async () => {
  const now = new Date();

  const expired = await prisma.hairTryOnUpload.findMany({
    where: { expiresAt: { lt: now }, deletedAt: null },
    select: {
      id: true,
      publicId: true,
      jobs: {
        where: { resultPublicId: { not: null } },
        select: { resultPublicId: true },
      },
    },
    orderBy: { expiresAt: "asc" },
    take: PURGE_BATCH,
  });

  const originals = expired.map((upload) => upload.publicId);
  const results = expired.flatMap((upload) =>
    upload.jobs.map((job) => job.resultPublicId as string),
  );

  if (expired.length > 0) {
    // Assets first: if Cloudinary fails, the rows stay unmarked and the next
    // run tries again instead of claiming a photo is gone when it is not.
    await HairCloudinary.deleteAssets([...originals, ...results]);
    await prisma.hairTryOnUpload.updateMany({
      where: { id: { in: expired.map((upload) => upload.id) } },
      data: { deletedAt: now },
    });
  }

  const purged = await prisma.hairTryOnUpload.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - ROW_KEEP_MS) } },
  });

  console.log(
    `[jobs] hair.cleanup: deleted ${originals.length} photo(s), ${results.length} result(s), purged ${purged.count} row(s)`,
  );
};

type TaggedResource = { public_id: string; created_at: string };

/**
 * The net under `purgeHairTryOn`: delete every `hair-tryon` asset older than
 * 48 hours, whatever the database says. Catches uploads whose row was never
 * written, results stored after a crash, and anything a failed run left.
 */
export const sweepHairTryOnTag = async () => {
  const cutoff = Date.now() - SWEEP_MAX_AGE_MS;
  const stale: string[] = [];
  let scanned = 0;
  let cursor: string | undefined;

  do {
    const page = (await cloudinary.api.resources_by_tag("hair-tryon", {
      type: "authenticated",
      resource_type: "image",
      max_results: SWEEP_PAGE_SIZE,
      ...(cursor ? { next_cursor: cursor } : {}),
    })) as { resources: TaggedResource[]; next_cursor?: string };

    scanned += page.resources.length;
    for (const resource of page.resources) {
      if (new Date(resource.created_at).getTime() < cutoff) {
        stale.push(resource.public_id);
      }
    }
    cursor = page.next_cursor;
  } while (cursor);

  if (stale.length > 0) await HairCloudinary.deleteAssets(stale);

  console.log(
    `[jobs] hair.sweep: scanned ${scanned} asset(s), deleted ${stale.length} older than 48 h`,
  );
};
