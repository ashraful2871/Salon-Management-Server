-- Ladies parlour / gents parlour / unisex, so customers can browse by it.

-- CreateEnum
CREATE TYPE "SalonAudience" AS ENUM ('UNISEX', 'LADIES', 'GENTS');

-- AlterTable
ALTER TABLE "salons" ADD COLUMN "audience" "SalonAudience" NOT NULL DEFAULT 'UNISEX';

-- Backfill. The name decides when it says so ("Ladies Parlour", "Barber
-- Shop"); otherwise a menu with only women's or only men's services does.
-- Anything unclear stays UNISEX, and the owner can change it.
UPDATE "salons" SET "audience" = 'GENTS'
WHERE "name" ~* '(gents|barber|\mmen''s|\mmens?\M|gentleman)';

UPDATE "salons" SET "audience" = 'LADIES'
WHERE "audience" = 'UNISEX'
  AND "name" ~* '(ladies|lady|women|beauty parlou?r|bridal|makeover)'
  AND "name" !~* 'unisex';

UPDATE "salons" s SET "audience" = 'LADIES'
WHERE s."audience" = 'UNISEX'
  AND s."name" !~* 'unisex'
  AND EXISTS (
    SELECT 1 FROM "services" sv
    WHERE sv."salonId" = s.id AND NOT sv."isDeleted"
      AND sv.name ~* '(ladies|bridal|mehedi|women)')
  AND NOT EXISTS (
    SELECT 1 FROM "services" sv
    WHERE sv."salonId" = s.id AND NOT sv."isDeleted"
      AND sv.name ~* '(beard|shave|\mmen\M|\mmen''s|\(men\)|gents)');

UPDATE "salons" s SET "audience" = 'GENTS'
WHERE s."audience" = 'UNISEX'
  AND s."name" !~* 'unisex'
  AND EXISTS (
    SELECT 1 FROM "services" sv
    WHERE sv."salonId" = s.id AND NOT sv."isDeleted"
      AND sv.name ~* '(beard|shave|\(men\)|gents)')
  AND NOT EXISTS (
    SELECT 1 FROM "services" sv
    WHERE sv."salonId" = s.id AND NOT sv."isDeleted"
      AND sv.name ~* '(ladies|bridal|mehedi|women|manicure|pedicure)');
