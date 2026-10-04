import { z } from "zod";

const createUpload = z.object({
  body: z.object({
    turnstileToken: z.string().max(4096),
  }),
});

const confirmUpload = z.object({
  params: z.object({ id: z.string().min(1).max(64) }),
  body: z.object({
    version: z.union([
      z.number().int().nonnegative(),
      z.string().trim().regex(/^\d+$/),
    ]),
    signature: z.string().trim().min(1).max(128),
  }),
});

const deleteUpload = z.object({
  params: z.object({ id: z.string().min(1).max(64) }),
});

const createJob = z.object({
  body: z.object({
    uploadId: z.string().trim().min(1).max(64),
    styleId: z.string().trim().min(1).max(64),
    colorId: z.string().trim().min(1).max(64).default("natural"),
  }),
});

const getJob = z.object({
  params: z.object({ id: z.string().min(1).max(64) }),
});

export const HairTryOnValidation = {
  createUpload,
  confirmUpload,
  deleteUpload,
  createJob,
  getJob,
};
