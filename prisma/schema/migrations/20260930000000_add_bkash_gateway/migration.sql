-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_provider_sessionKey_key" ON "payment_intents"("provider", "sessionKey");

-- CreateTable
CREATE TABLE "gateway_tokens" (
    "provider" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "refreshExpiresAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "gateway_tokens_pkey" PRIMARY KEY ("provider")
);
