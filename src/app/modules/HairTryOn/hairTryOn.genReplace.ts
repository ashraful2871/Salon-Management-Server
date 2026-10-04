import { HairColor, HairStyle } from "./hairTryOn.catalog";
import { HairCloudinary } from "./hairTryOn.cloudinary";
import {
  HairEditError,
  HairEditProvider,
  toHairEditError,
} from "./hairTryOn.provider";

// Cloudinary's generative replace, chosen in Phase 0 (no Gemini image quota).
// It only repaints the existing hair area, so it can't add length.
const MODEL = "cloudinary/gen_replace";
const POLL_MS = 3000;
const SAFETY_HINT = /safety|moderat|inappropriate|nsfw|prohibited/i;

/** gen_replace takes a short phrase; commas and semicolons would break the URL. */
export const phrase = (style: HairStyle, color: HairColor) =>
  `${color.prompt ? `${color.prompt} ` : ""}${style.name} hairstyle`
    .toLowerCase()
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export const cloudinaryHairProvider: HairEditProvider = {
  name: "cloudinary",
  async edit({ publicId, style, color, signal }) {
    const url = HairCloudinary.signedUrl(publicId, [
      { crop: "limit", width: 1024 },
      { effect: `gen_replace:from_hair;to_${phrase(style, color)}` },
      { fetch_format: "jpg", quality: 90 },
    ]);

    try {
      // The derivative is generated on first request; 423 means "still making it".
      let response = await fetch(url, { signal });
      while (response.status === 423) {
        await wait(POLL_MS, signal);
        response = await fetch(url, { signal });
      }

      if (!response.ok) {
        const reason = response.headers.get("x-cld-error") ?? "";
        throw new HairEditError(
          SAFETY_HINT.test(reason) ? "SAFETY_BLOCKED" : "PROVIDER_ERROR",
          `HTTP ${response.status} ${reason}`.trim().slice(0, 300),
        );
      }

      return {
        image: Buffer.from(await response.arrayBuffer()),
        mimeType: "image/jpeg",
        model: MODEL,
      };
    } catch (error) {
      throw toHairEditError(error, signal);
    }
  },
};
