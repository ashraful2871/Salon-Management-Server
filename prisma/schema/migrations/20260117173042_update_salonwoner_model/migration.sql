/*
  Warnings:

  - A unique constraint covering the columns `[userId]` on the table `salon_owners` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "salon_owners_userId_key" ON "salon_owners"("userId");
