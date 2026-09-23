-- Phase 6: token counts per model turn. Purely additive, both nullable.
ALTER TABLE "assistant_messages" ADD COLUMN "tokensIn" INTEGER;
ALTER TABLE "assistant_messages" ADD COLUMN "tokensOut" INTEGER;
