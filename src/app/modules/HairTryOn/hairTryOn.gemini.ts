import { GoogleGenAI } from "@google/genai";
import config from "../../../config";
import { buildPrompt } from "./hairTryOn.catalog";
import { HairCloudinary } from "./hairTryOn.cloudinary";
import {
  HairEditError,
  HairEditProvider,
  toHairEditError,
} from "./hairTryOn.provider";

const SAFETY_REASONS = new Set(["SAFETY", "PROHIBITED_CONTENT", "IMAGE_SAFETY"]);

let client: GoogleGenAI | undefined;
const getClient = () =>
  (client ??= new GoogleGenAI({ apiKey: config.ai.geminiApiKey }));

const fetchSource = async (publicId: string, signal: AbortSignal) => {
  const response = await fetch(
    HairCloudinary.signedUrl(publicId, [
      { crop: "limit", width: 1024, fetch_format: "jpg", quality: "auto" },
    ]),
    { signal },
  );
  if (!response.ok) {
    throw new HairEditError(
      "PROVIDER_ERROR",
      `Source fetch failed: HTTP ${response.status}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
};

export const geminiHairProvider: HairEditProvider = {
  name: "gemini",
  async edit({ publicId, style, color, signal }) {
    try {
      const image = await fetchSource(publicId, signal);
      const response = await getClient().models.generateContent({
        model: config.hairTryOn.model,
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: image.toString("base64"),
                },
              },
              { text: buildPrompt(style, color) },
            ],
          },
        ],
        config: { responseModalities: ["IMAGE"], abortSignal: signal },
      });

      const candidate = response.candidates?.[0];
      const blockReason = response.promptFeedback?.blockReason;
      const finishReason = String(candidate?.finishReason ?? "");
      if (blockReason || SAFETY_REASONS.has(finishReason)) {
        throw new HairEditError(
          "SAFETY_BLOCKED",
          `Blocked: ${blockReason ?? finishReason}`,
        );
      }

      const part = candidate?.content?.parts?.find((p) => p.inlineData?.data);
      if (!part?.inlineData?.data) {
        throw new HairEditError("SAFETY_BLOCKED", "No image in the response");
      }

      return {
        image: Buffer.from(part.inlineData.data, "base64"),
        mimeType: part.inlineData.mimeType ?? "image/png",
        model: config.hairTryOn.model,
      };
    } catch (error) {
      throw toHairEditError(error, signal);
    }
  },
};
