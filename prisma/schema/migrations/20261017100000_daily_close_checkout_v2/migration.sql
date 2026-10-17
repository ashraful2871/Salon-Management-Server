-- AlterTable
ALTER TABLE "appointments" ADD COLUMN "discountMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "discountReason" TEXT,
ADD COLUMN "tipMinor" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "tipMinor" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "daily_closes" (
    "id" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "expectedCashMinor" INTEGER NOT NULL,
    "countedCashMinor" INTEGER NOT NULL,
    "cardMinor" INTEGER NOT NULL,
    "mobileMinor" INTEGER NOT NULL,
    "differenceMinor" INTEGER NOT NULL,
    "note" TEXT,
    "closedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_closes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "daily_closes_salonId_date_key" ON "daily_closes"("salonId", "date");

-- AddForeignKey
ALTER TABLE "daily_closes" ADD CONSTRAINT "daily_closes_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "salons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
