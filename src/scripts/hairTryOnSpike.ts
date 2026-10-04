/**
 * Model test / eval for the hairstyle try-on: every photo in a folder x
 * catalog styles, one call at a time, results written to
 * spike-out/<folder>/<photo>__<provider>-<styleId>.<ext> for scoring by eye.
 *
 *   npm run hair:spike                          # spike-photos/, 8 most-used styles
 *   npm run hair:spike -- eval-photos           # another folder
 *   npm run hair:spike -- eval-photos --styles=afro,low-fade --photos=a.jpg,b.jpg
 *
 * Styles come from hairTryOn.catalog.ts and are sent exactly as production
 * sends them (gen_replace phrase, or buildPrompt for Gemini), natural color.
 * Without --styles: the eight styles with the most jobs, topped up from
 * DEFAULT_STYLES. HAIR_IMAGE_PROVIDER picks the route: "gemini" (needs
 * billing) or "cloudinary" (e_gen_replace on the plan's monthly credits).
 * Cloudinary test uploads are deleted after each photo. Keep eval folders
 * gitignored: only consented photos belong in them.
 */
import fs from "fs";
import path from "path";
import config from "../config";
import prisma from "../app/shared/prisma";
import {
  HAIR_STYLES,
  HairStyle,
  buildPrompt,
  findColor,
  findStyle,
} from "../app/modules/HairTryOn/hairTryOn.catalog";
import { phrase } from "../app/modules/HairTryOn/hairTryOn.genReplace";
import {
  EditResult,
  OUT_DIR,
  PHOTO_DIR,
  cloudinaryCredits,
  cloudinaryDelete,
  cloudinaryEdit,
  cloudinaryUpload,
  configureCloudinary,
  errorText,
  geminiEdit,
  listPhotos,
  provider,
  providerLabel,
} from "./hairTryOnLib";

const STYLE_COUNT = 8;
// Short, fade and curly styles: what Cloudinary can do (long is hidden in the UI).
const DEFAULT_STYLES = [
  "buzz-cut",
  "low-fade",
  "side-part",
  "crew-cut",
  "textured-crop",
  "high-fade-quiff",
  "natural-curls",
  "afro",
];
const NATURAL = findColor("natural")!;

const arg = (name: string) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const pickStyles = async (): Promise<HairStyle[]> => {
  const asked = arg("styles");
  if (asked) {
    const unknown = asked.filter((id) => !findStyle(id));
    if (unknown.length) throw new Error(`unknown style id(s): ${unknown.join(", ")}`);
    return asked.map((id) => findStyle(id)!);
  }
  let used: string[] = [];
  try {
    const counts = await prisma.hairTryOnJob.groupBy({
      by: ["styleId"],
      _count: { styleId: true },
      orderBy: { _count: { styleId: "desc" } },
      take: STYLE_COUNT,
    });
    used = counts.map((row) => row.styleId).filter((id) => findStyle(id));
    console.log(`Most-used styles: ${counts.map((r) => `${r.styleId} (${r._count.styleId})`).join(", ") || "none yet"}`);
  } catch (error) {
    console.log(`Job counts unavailable (${errorText(error)}); using defaults.`);
  }
  const ids = [...new Set([...used, ...DEFAULT_STYLES])].slice(0, STYLE_COUNT);
  return ids.map((id) => HAIR_STYLES.find((s) => s.id === id)!);
};

type Row = { photo: string; style: string; ms: number; result: string };

const main = async () => {
  const route = provider();
  if (route === "gemini" && !config.ai.geminiApiKey) {
    console.error("GEMINI_API_KEY missing");
    process.exitCode = 1;
    return;
  }
  const folder = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const photoDir = folder ? path.resolve(folder) : PHOTO_DIR;
  const outDir = folder ? path.join(OUT_DIR, path.basename(photoDir)) : OUT_DIR;
  const only = arg("photos");
  const photos = listPhotos(photoDir).filter((p) => !only || only.includes(p));
  if (!photos.length) {
    console.error(`No photos in ${photoDir} (jpg, jpeg, png, webp, heic).`);
    process.exitCode = 1;
    return;
  }
  const styles = await pickStyles();
  fs.mkdirSync(outDir, { recursive: true });
  if (route === "cloudinary") configureCloudinary();
  const creditsBefore = route === "cloudinary" ? await cloudinaryCredits() : null;

  const rows: Row[] = [];
  const total = photos.length * styles.length;
  console.log(`Provider ${providerLabel()}: ${photos.length} photo(s) x ${styles.length} styles = ${total} calls`);
  console.log(`Styles: ${styles.map((s) => s.id).join(", ")}\nOutput: ${outDir}\n`);

  for (const photo of photos) {
    const source = path.join(photoDir, photo);
    const base = path.parse(photo).name;
    let publicId: string | undefined;
    if (route === "cloudinary") {
      try {
        publicId = await cloudinaryUpload(source);
      } catch (error) {
        console.log(`${photo} | upload failed: ${errorText(error)}`);
        continue;
      }
    }

    try {
      for (const style of styles) {
        const started = Date.now();
        const edit: EditResult = publicId
          ? await cloudinaryEdit(publicId, phrase(style, NATURAL))
          : await geminiEdit(source, buildPrompt(style, NATURAL));
        const ms = Date.now() - started;
        let result: string;
        if (edit.ok) {
          const file = `${base}__${route}-${style.id}.${edit.ext}`;
          fs.writeFileSync(path.join(outDir, file), edit.image);
          result = `ok -> ${file}`;
        } else {
          result = `error: ${edit.error}`;
        }
        rows.push({ photo, style: style.id, ms, result });
        console.log(`[${rows.length}/${total}] ${photo} | ${style.id} | ${ms} ms | ${result}`);
        if (!edit.ok && edit.quota) {
          console.error(
            route === "gemini"
              ? "\nStopped: quota exhausted (429). Image models have no free tier - enable billing, or set HAIR_IMAGE_PROVIDER=cloudinary."
              : "\nStopped: Cloudinary refused for quota - check the plan's credits.",
          );
          process.exitCode = 1;
          return;
        }
      }
    } finally {
      if (publicId) await cloudinaryDelete(publicId).catch(() => undefined);
    }
  }

  const ok = rows.filter((row) => row.result.startsWith("ok"));
  const times = ok.map((row) => row.ms).sort((a, b) => a - b);
  console.log("\nphoto | style | ms | result");
  console.log("--- | --- | ---: | ---");
  for (const row of rows) console.log(`${row.photo} | ${row.style} | ${row.ms} | ${row.result}`);
  console.log(`\n${ok.length}/${rows.length} images returned.`);
  if (times.length) {
    const avg = Math.round(times.reduce((sum, ms) => sum + ms, 0) / times.length);
    const p50 = times[Math.floor((times.length - 1) / 2)];
    console.log(`Latency (successful calls): avg ${avg} ms, p50 ${p50} ms, min ${times[0]} ms, max ${times[times.length - 1]} ms`);
  }
  if (creditsBefore) {
    const after = await cloudinaryCredits();
    console.log(
      `Cloudinary ${creditsBefore.plan} plan credits: ${creditsBefore.used} -> ${after?.used ?? "?"} of ${creditsBefore.limit} (usage can lag by hours)`,
    );
  }
  console.log("Score each image 1-5 on: face kept / skin tone / realism / style match. Any skin lightening is a fail.");
};

main()
  .catch((error) => {
    console.error("hair:spike crashed:", errorText(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
