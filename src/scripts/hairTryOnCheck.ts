/**
 * Pre-flight for the hairstyle try-on: are the keys set, does Cloudinary answer,
 * is the signed upload preset set up right, is the Turnstile secret real, and
 * does the selected image route (HAIR_IMAGE_PROVIDER) return an image.
 *
 *   npm run hair:check
 *
 * Read-only except for one image edit on the first photo in spike-photos/
 * (a Gemini call, or a Cloudinary upload + gen_replace that is deleted after).
 * Prints set/missing and pass/fail only - never a key, a secret or a URL.
 * Exits 1 if any check failed.
 */
import path from "path";
import { v2 as cloudinary } from "cloudinary";
import config from "../config";
import {
  EditResult,
  PHOTO_DIR,
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

const CHECK_PROMPT =
  "Change only the hair to a short buzz cut. Keep everything else the same.";
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
// Cloudflare's "always passes" test secret: fine locally, never in production.
const TEST_SECRET = "1x0000000000000000000000000000000AA";

let failures = 0;
const report = (ok: boolean, label: string, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` - ${detail}` : ""}`);
};

const checkEnv = () => {
  const names = [
    "CLOUDINARY_CLOUD_NAME",
    "CLOUDINARY_API_KEY",
    "CLOUDINARY_API_SECRET",
    "TURNSTILE_SECRET_KEY",
  ];
  // The Gemini keys only matter when Gemini does the edit.
  if (provider() === "gemini") names.push("GEMINI_API_KEY", "HAIR_IMAGE_MODEL");
  for (const name of names) {
    const set = Boolean(process.env[name]?.trim());
    report(set, `env ${name}`, set ? "set" : "missing");
  }
};

const cloudinaryReady = () =>
  Boolean(
    config.cloudinary.cloud_name &&
      config.cloudinary.api_key &&
      config.cloudinary.api_secret,
  );

const checkCloudinaryPing = async () => {
  if (!cloudinaryReady()) return report(false, "Cloudinary ping", "credentials missing");
  try {
    const result = await cloudinary.api.ping();
    report(result?.status === "ok", "Cloudinary ping");
  } catch (error) {
    report(false, "Cloudinary ping", errorText(error));
  }
};

const checkUploadPreset = async () => {
  const name = config.hairTryOn.uploadPreset;
  if (!cloudinaryReady()) return report(false, `upload preset "${name}"`, "credentials missing");
  try {
    const preset = (await cloudinary.api.upload_preset(name)) as {
      unsigned?: boolean;
      settings?: { type?: string };
    };
    report(true, `upload preset "${name}" exists`);
    report(preset.unsigned === false, "upload preset is signed", `unsigned=${preset.unsigned}`);
    report(
      preset.settings?.type === "authenticated",
      "upload preset delivery type is authenticated",
      `type=${preset.settings?.type ?? "upload (default)"}`,
    );
  } catch (error) {
    report(false, `upload preset "${name}" exists`, errorText(error));
  }
};

const checkTurnstile = async () => {
  const secret = config.hairTryOn.turnstileSecret;
  if (!secret) return report(false, "Turnstile secret accepted", "TURNSTILE_SECRET_KEY missing");
  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ secret, response: DUMMY_TOKEN }),
      },
    );
    const body = (await response.json()) as {
      success?: boolean;
      "error-codes"?: string[];
    };
    const codes = body["error-codes"] ?? [];
    if (secret === TEST_SECRET) {
      return report(
        response.status === 200 && body.success === true,
        "Turnstile secret accepted",
        "Cloudflare TEST secret - use the real one in production",
      );
    }
    report(
      response.status === 200 &&
        body.success === false &&
        !codes.includes("invalid-input-secret"),
      "Turnstile secret accepted",
      `HTTP ${response.status}, error-codes=[${codes.join(",")}]`,
    );
  } catch (error) {
    report(false, "Turnstile secret accepted", errorText(error));
  }
};

const checkImageEdit = async () => {
  const label = `image edit via ${providerLabel()} returns an image`;
  const photo = listPhotos()[0];
  if (!photo) return report(false, label, "no photo in spike-photos/");
  const photoPath = path.join(PHOTO_DIR, photo);
  const started = Date.now();
  let edit: EditResult;

  if (provider() === "cloudinary") {
    if (!cloudinaryReady()) return report(false, label, "Cloudinary credentials missing");
    let publicId: string;
    try {
      publicId = await cloudinaryUpload(photoPath);
    } catch (error) {
      return report(false, label, `upload failed: ${errorText(error)}`);
    }
    try {
      edit = await cloudinaryEdit(publicId, "short buzz cut hairstyle");
    } finally {
      await cloudinaryDelete(publicId).catch(() => undefined);
    }
  } else {
    if (!config.ai.geminiApiKey) return report(false, label, "GEMINI_API_KEY missing");
    edit = await geminiEdit(photoPath, CHECK_PROMPT);
  }

  const ms = Date.now() - started;
  report(edit.ok, label, edit.ok ? `${ms} ms` : `${edit.error} (${ms} ms)`);
};

const main = async () => {
  configureCloudinary();

  console.log(`Hairstyle try-on pre-flight (provider: ${provider()})\n`);
  checkEnv();
  await checkCloudinaryPing();
  await checkUploadPreset();
  await checkTurnstile();
  await checkImageEdit();

  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
  // exitCode, not process.exit(): exiting while fetch sockets are still closing
  // trips a libuv assertion on Windows (UV_HANDLE_CLOSING).
  process.exitCode = failures ? 1 : 0;
};

main().catch((error) => {
  console.error("hair:check crashed:", errorText(error));
  process.exitCode = 1;
});
