import { v2 as cloudinary, TransformationOptions } from "cloudinary";
import config from "../../../config";

// The only file in the module that talks to Cloudinary. Every try-on asset is
// `type: "authenticated"`, so nothing is reachable without a signed URL.
cloudinary.config({
  cloud_name: config.cloudinary.cloud_name,
  api_key: config.cloudinary.api_key,
  api_secret: config.cloudinary.api_secret,
  secure: true,
});

/**
 * A one-shot ticket for a direct browser upload. The browser must post exactly
 * these params plus `file`, `api_key` and `signature`, or Cloudinary rejects
 * the signature.
 */
const signUpload = (publicId: string) => {
  const params = {
    public_id: publicId,
    timestamp: Math.round(Date.now() / 1000),
    upload_preset: config.hairTryOn.uploadPreset,
    type: "authenticated",
    faces: "true",
    tags: "hair-tryon,hair-tryon-original",
  };
  const signature = cloudinary.utils.api_sign_request(
    params,
    config.cloudinary.api_secret as string,
  );

  return {
    cloudName: config.cloudinary.cloud_name as string,
    apiKey: config.cloudinary.api_key as string,
    uploadUrl: `https://api.cloudinary.com/v1_1/${config.cloudinary.cloud_name}/image/upload`,
    params: { ...params, signature },
  };
};

/** True when the `signature` from the browser's upload response is Cloudinary's. */
const verifyUpload = (
  publicId: string,
  version: number | string,
  signature: string,
): boolean =>
  (
    cloudinary.utils as unknown as {
      verify_api_response_signature: (
        publicId: string,
        version: number | string,
        signature: string,
      ) => boolean;
    }
  ).verify_api_response_signature(publicId, version, signature);

const getUploadInfo = async (publicId: string) => {
  const resource = await cloudinary.api.resource(publicId, {
    type: "authenticated",
    faces: true,
  });

  return {
    width: resource.width as number,
    height: resource.height as number,
    bytes: resource.bytes as number,
    format: resource.format as string,
    faceCount: (resource.faces as unknown[] | undefined)?.length ?? 0,
  };
};

const signedUrl = (
  publicId: string,
  transformation: TransformationOptions,
): string =>
  cloudinary.url(publicId, {
    type: "authenticated",
    sign_url: true,
    secure: true,
    transformation,
  });

const uploadBuffer = (buffer: Buffer, publicId: string) =>
  new Promise<{ publicId: string; width: number; height: number; bytes: number }>(
    (resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          public_id: publicId,
          type: "authenticated",
          resource_type: "image",
          tags: ["hair-tryon", "hair-tryon-result"],
        },
        (error, result) => {
          if (error || !result) return reject(error ?? new Error("Upload failed"));
          resolve({
            publicId: result.public_id,
            width: result.width,
            height: result.height,
            bytes: result.bytes,
          });
        },
      );
      stream.end(buffer);
    },
  );

/**
 * Delete authenticated images, 100 per Admin API call (its maximum).
 * `invalidate` also purges the CDN, or a signed URL handed out earlier keeps
 * serving the cached photo after the delete.
 */
const deleteAssets = async (publicIds: string[]) => {
  for (let i = 0; i < publicIds.length; i += 100) {
    await cloudinary.api.delete_resources(publicIds.slice(i, i + 100), {
      type: "authenticated",
      resource_type: "image",
      invalidate: true,
    });
  }
};

export const HairCloudinary = {
  signUpload,
  verifyUpload,
  getUploadInfo,
  signedUrl,
  uploadBuffer,
  deleteAssets,
};
