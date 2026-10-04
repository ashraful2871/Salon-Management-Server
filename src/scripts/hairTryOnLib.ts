/**
 * Shared by hair:check and hair:spike: the two image-edit routes under test.
 *
 * - gemini: one generateContent call with the photo inline; needs a billed
 *   project (image models have no free tier).
 * - cloudinary: upload once as an authenticated asset, then request a signed
 *   `e_gen_replace:from_hair;to_<style>` derivative; runs on the plan's
 *   monthly credits, so it works on the Free plan. It only repaints the hair
 *   region, which keeps the face exact but limits how far the shape can change.
 */
import fs from "fs";
import path from "path";
import { v2 as cloudinary } from "cloudinary";
import { GoogleGenAI } from "@google/genai";
import config from "../config";

export const PHOTO_DIR = path.join(process.cwd(), "spike-photos");
export const OUT_DIR = path.join(process.cwd(), "spike-out");
export const PHOTO_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
};
const OUTPUT_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export type Provider = "gemini" | "cloudinary";
export const provider = (): Provider =>
  config.hairTryOn.provider === "cloudinary" ? "cloudinary" : "gemini";
export const providerLabel = () =>
  provider() === "cloudinary" ? "cloudinary e_gen_replace" : config.hairTryOn.model;

export type EditResult =
  | { ok: true; image: Buffer; ext: string }
  | { ok: false; error: string; quota: boolean };

export const listPhotos = (dir = PHOTO_DIR) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .sort()
        .filter((name) => PHOTO_TYPES[path.extname(name).toLowerCase()])
    : [];

/** Readable error, never a secret: the SDKs put the API's JSON in `message`. */
export const errorText = (error: unknown) => {
  const raw = error instanceof Error ? error.message : String(error);
  // Cloudinary rejects with { error: { message, http_code } }, not an Error.
  let text = (error as { error?: { message?: string } })?.error?.message || raw;
  try {
    text = JSON.parse(text)?.error?.message ?? text;
  } catch {
    // not JSON: keep it as is
  }
  return text.replace(/\s+/g, " ").slice(0, 400);
};

const isQuotaError = (error: unknown) =>
  /"code":\s*429|RESOURCE_EXHAUSTED/.test(
    error instanceof Error ? error.message : String(error),
  );

// ---- Gemini ---------------------------------------------------------------

let gemini: GoogleGenAI | undefined;

export const geminiEdit = async (
  photoPath: string,
  prompt: string,
): Promise<EditResult> => {
  gemini ??= new GoogleGenAI({ apiKey: config.ai.geminiApiKey });
  try {
    const response = await gemini.models.generateContent({
      model: config.hairTryOn.model,
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: PHOTO_TYPES[path.extname(photoPath).toLowerCase()],
                data: fs.readFileSync(photoPath).toString("base64"),
              },
            },
            { text: prompt },
          ],
        },
      ],
      config: { responseModalities: ["IMAGE"] },
    });
    const candidate = response.candidates?.[0];
    const part = candidate?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part?.inlineData?.data) {
      return {
        ok: false,
        quota: false,
        error: `no image part (finishReason=${candidate?.finishReason ?? "none"}, block=${response.promptFeedback?.blockReason ?? "none"})`,
      };
    }
    return {
      ok: true,
      image: Buffer.from(part.inlineData.data, "base64"),
      ext: OUTPUT_EXT[part.inlineData.mimeType ?? ""] ?? "png",
    };
  } catch (error) {
    return { ok: false, quota: isQuotaError(error), error: errorText(error) };
  }
};

// ---- Cloudinary -------------------------------------------------------------

export const configureCloudinary = () =>
  cloudinary.config({
    cloud_name: config.cloudinary.cloud_name,
    api_key: config.cloudinary.api_key,
    api_secret: config.cloudinary.api_secret,
    secure: true,
  });

export const cloudinaryUpload = async (photoPath: string) => {
  const uploaded = await cloudinary.uploader.upload(photoPath, {
    type: "authenticated",
    folder: "hair-spike",
    tags: ["hair-tryon", "hair-spike"],
    transformation: [{ crop: "limit", width: 1600, height: 1600, quality: "auto:good" }],
  });
  return uploaded.public_id;
};

export const cloudinaryDelete = (publicId: string) =>
  cloudinary.api.delete_resources([publicId], { type: "authenticated" });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Generative transformations are made on first request; Cloudinary answers 423
 * while one is still being produced, so poll for up to ~2 minutes.
 */
export const cloudinaryEdit = async (
  publicId: string,
  phrase: string,
): Promise<EditResult> => {
  const url = cloudinary.url(publicId, {
    type: "authenticated",
    sign_url: true,
    format: "png",
    transformation: [{ effect: `gen_replace:from_hair;to_${phrase}` }],
  });
  try {
    let response = await fetch(url);
    for (let tries = 0; response.status === 423 && tries < 24; tries++) {
      await sleep(5000);
      response = await fetch(url);
    }
    if (!response.ok) {
      const reason = response.headers.get("x-cld-error") || "";
      return {
        ok: false,
        quota: response.status === 420 || response.status === 429,
        error: `HTTP ${response.status} ${reason}`.trim().slice(0, 300),
      };
    }
    return { ok: true, image: Buffer.from(await response.arrayBuffer()), ext: "png" };
  } catch (error) {
    return { ok: false, quota: false, error: errorText(error) };
  }
};

/** Credits used this cycle, or null when the Admin API won't say. */
export const cloudinaryCredits = async () => {
  try {
    const usage = (await cloudinary.api.usage()) as {
      plan?: string;
      credits?: { usage?: number; limit?: number };
    };
    return { plan: usage.plan, used: usage.credits?.usage, limit: usage.credits?.limit };
  } catch {
    return null;
  }
};
