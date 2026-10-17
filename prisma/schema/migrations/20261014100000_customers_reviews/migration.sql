-- AlterTable: one public owner reply per review
ALTER TABLE "reviews" ADD COLUMN "ownerReply" TEXT,
ADD COLUMN "ownerRepliedAt" TIMESTAMP(3),
ADD COLUMN "ownerReplyById" TEXT;

-- CreateTable
CREATE TABLE "customer_notes" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "note" TEXT,
    "tags" TEXT[],
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_notes_ownerId_customerId_key" ON "customer_notes"("ownerId", "customerId");
