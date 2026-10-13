-- Invoice numbers: SK-<yyyy>-<6-digit nextval>. A sequence never hands out a
-- value twice, even when the transaction that took it rolls back.
CREATE SEQUENCE "owner_invoice_seq" START WITH 1 INCREMENT BY 1 MINVALUE 1 NO CYCLE;

-- CreateTable
CREATE TABLE "owner_statements" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "kind" "StatementKind" NOT NULL,
    "number" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "payoutId" TEXT,
    "totals" JSONB NOT NULL,
    "ledgerHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_statements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "owner_statements_number_key" ON "owner_statements"("number");

-- CreateIndex
CREATE UNIQUE INDEX "owner_statements_payoutId_key" ON "owner_statements"("payoutId");

-- CreateIndex
CREATE INDEX "owner_statements_ownerId_createdAt_idx" ON "owner_statements"("ownerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "owner_statements_ownerId_kind_periodStart_key" ON "owner_statements"("ownerId", "kind", "periodStart");

-- AddForeignKey
ALTER TABLE "owner_statements" ADD CONSTRAINT "owner_statements_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "salon_owners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A statement is a snapshot: rows are inserted once and never edited
-- (deleting an owner still cascades).
CREATE OR REPLACE FUNCTION owner_statements_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'owner_statements rows are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER owner_statements_no_update
  BEFORE UPDATE ON "owner_statements"
  FOR EACH ROW EXECUTE FUNCTION owner_statements_immutable();
