-- AlterTable: slots can be assigned to a counter (chair/station)
ALTER TABLE "slots" ADD COLUMN "counterId" TEXT;

-- CreateIndex
CREATE INDEX "slots_counterId_idx" ON "slots"("counterId");
CREATE INDEX "slots_salonId_date_idx" ON "slots"("salonId", "date");

-- AddForeignKey
ALTER TABLE "slots" ADD CONSTRAINT "slots_counterId_fkey" FOREIGN KEY ("counterId") REFERENCES "counters"("id") ON DELETE SET NULL ON UPDATE CASCADE;
