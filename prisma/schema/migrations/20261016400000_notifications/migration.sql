-- Owner Phase 13: in-app notifications, per-event preferences, booking email mode.

-- AlterTable
ALTER TABLE "salon_owners" ADD COLUMN "bookingEmailMode" TEXT NOT NULL DEFAULT 'DIGEST';

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "salonId" TEXT,
    "dedupeKey" TEXT,
    "shown" BOOLEAN NOT NULL DEFAULT true,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_prefs" (
    "userId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "email" BOOLEAN NOT NULL,
    "inApp" BOOLEAN NOT NULL,

    CONSTRAINT "notification_prefs_pkey" PRIMARY KEY ("userId","event")
);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_userId_dedupeKey_key" ON "notifications"("userId", "dedupeKey");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_createdAt_idx" ON "notifications"("userId", "readAt", "createdAt");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
