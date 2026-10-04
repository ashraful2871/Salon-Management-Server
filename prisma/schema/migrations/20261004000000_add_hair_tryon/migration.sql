-- CreateEnum
CREATE TYPE "HairTryOnStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "hair_tryon_uploads" (
    "id" TEXT NOT NULL,
    "ownerTokenHash" TEXT NOT NULL,
    "clientKey" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "width" INTEGER,
    "height" INTEGER,
    "bytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "hair_tryon_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hair_tryon_jobs" (
    "id" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "styleId" TEXT NOT NULL,
    "colorId" TEXT NOT NULL DEFAULT 'natural',
    "status" "HairTryOnStatus" NOT NULL DEFAULT 'PENDING',
    "resultPublicId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "errorCode" TEXT,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "hair_tryon_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hair_tryon_uploads_publicId_key" ON "hair_tryon_uploads"("publicId");

-- CreateIndex
CREATE INDEX "hair_tryon_uploads_expiresAt_idx" ON "hair_tryon_uploads"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "hair_tryon_jobs_uploadId_styleId_colorId_key" ON "hair_tryon_jobs"("uploadId", "styleId", "colorId");

-- CreateIndex
CREATE INDEX "hair_tryon_jobs_status_createdAt_idx" ON "hair_tryon_jobs"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "hair_tryon_jobs" ADD CONSTRAINT "hair_tryon_jobs_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "hair_tryon_uploads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
