import config from "../../../config";
import { HairColor, HairStyle } from "./hairTryOn.catalog";
import { cloudinaryHairProvider } from "./hairTryOn.genReplace";
import { geminiHairProvider } from "./hairTryOn.gemini";

export type HairEditErrorCode = "SAFETY_BLOCKED" | "PROVIDER_ERROR" | "TIMEOUT";

export class HairEditError extends Error {
  constructor(
    public code: HairEditErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The original is already on Cloudinary, so a provider gets its public id and
 * fetches what it needs: Gemini downloads the bytes, Cloudinary edits in place.
 * Each provider also words its own prompt (gen_replace takes a short phrase).
 */
export type HairEditInput = {
  publicId: string;
  style: HairStyle;
  color: HairColor;
  signal: AbortSignal;
};

export interface HairEditProvider {
  name: string;
  edit(
    input: HairEditInput,
  ): Promise<{ image: Buffer; mimeType: string; model: string }>;
}

/** Map an abort (our timeout) to TIMEOUT and anything unrecognised to PROVIDER_ERROR. */
export const toHairEditError = (error: unknown, signal: AbortSignal) => {
  if (error instanceof HairEditError) return error;
  if (signal.aborted) return new HairEditError("TIMEOUT", "Edit timed out");
  const message = error instanceof Error ? error.message : String(error);
  return new HairEditError("PROVIDER_ERROR", message.slice(0, 300));
};

export const getProvider = (): HairEditProvider => {
  switch (config.hairTryOn.provider) {
    case "cloudinary":
      return cloudinaryHairProvider;
    case "gemini":
    default:
      return geminiHairProvider;
  }
};
