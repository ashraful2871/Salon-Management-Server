-- CreateTable
CREATE TABLE "salon_closures" (
    "id" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "allDay" BOOLEAN NOT NULL DEFAULT true,
    "startTime" TEXT,
    "endTime" TEXT,
    "reason" TEXT NOT NULL,
    "blockedSlotIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salon_closures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "salon_closures_salonId_date_idx" ON "salon_closures"("salonId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "salon_closures_salonId_date_startTime_key" ON "salon_closures"("salonId", "date", "startTime");

-- AddForeignKey
ALTER TABLE "salon_closures" ADD CONSTRAINT "salon_closures_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "salons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
