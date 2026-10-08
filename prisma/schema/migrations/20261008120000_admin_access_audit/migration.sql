-- Admin Phase 1: admin roles, append-only audit log, internal admin notes.

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'OPERATIONS', 'FINANCE', 'SUPPORT', 'MODERATOR', 'ANALYST');

-- AlterTable
ALTER TABLE "admins" ADD COLUMN "adminRole" "AdminRole" NOT NULL DEFAULT 'ANALYST',
ADD COLUMN "invitedById" TEXT,
ADD COLUMN "alertEmails" BOOLEAN NOT NULL DEFAULT true;

-- Every admin that exists today had full access; keep it that way.
UPDATE "admins" SET "adminRole" = 'SUPER_ADMIN';

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorRole" TEXT NOT NULL,
    "onBehalfOfUserId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'api',
    "salonId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_notes" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");
CREATE INDEX "audit_logs_actorUserId_createdAt_idx" ON "audit_logs"("actorUserId", "createdAt");
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");
CREATE INDEX "audit_logs_salonId_createdAt_idx" ON "audit_logs"("salonId", "createdAt");
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");
CREATE INDEX "admin_notes_entityType_entityId_createdAt_idx" ON "admin_notes"("entityType", "entityId", "createdAt");

-- Audit rows are immutable. Only the retention job deletes them, and it must
-- SET LOCAL app.audit_purge = 'on' inside its transaction first.
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'audit_logs rows are immutable'; END IF;
  IF current_setting('app.audit_purge', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'audit_logs rows are deleted only by the retention job';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
