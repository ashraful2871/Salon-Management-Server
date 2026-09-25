-- The in-chat booking assistant: one row per conversation holding the booking
-- draft (`state`), plus the transcript that produced it. Written by hand so the
-- pgvector index and the PostGIS index Prisma cannot see are left alone.

CREATE TYPE "AssistantRole" AS ENUM ('USER', 'ASSISTANT', 'TOOL');

CREATE TABLE "assistant_conversations" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "anonymousId" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "state" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "appointmentId" TEXT,
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "assistant_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "AssistantRole" NOT NULL,
    "text" TEXT,
    "blocks" JSONB,
    "action" JSONB,
    "model" TEXT,
    "promptVersion" TEXT,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_messages_pkey" PRIMARY KEY ("id")
);

-- "my chats, newest first" for a signed-in customer
CREATE INDEX "assistant_conversations_userId_createdAt_idx" ON "assistant_conversations"("userId", "createdAt");

-- the guest owner key, checked on every turn
CREATE INDEX "assistant_conversations_anonymousId_idx" ON "assistant_conversations"("anonymousId");

-- the retention sweep
CREATE INDEX "assistant_conversations_expiresAt_idx" ON "assistant_conversations"("expiresAt");

-- replaying a transcript in order
CREATE INDEX "assistant_messages_conversationId_createdAt_idx" ON "assistant_messages"("conversationId", "createdAt");

-- Deleting an account takes its chats with it; deleting a chat takes its
-- messages. Nothing here is worth keeping once its owner is gone.
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
