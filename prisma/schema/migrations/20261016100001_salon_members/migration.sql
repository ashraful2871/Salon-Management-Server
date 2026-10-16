-- AlterTable
ALTER TABLE "salons" ADD COLUMN "managerCanEditServices" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "salon_members" (
    "id" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "BranchRole" NOT NULL,
    "status" "MemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "invitedById" TEXT,
    "notifyNewBookings" BOOLEAN NOT NULL DEFAULT true,
    "removedAt" TIMESTAMP(3),
    "removedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salon_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salon_invitations" (
    "id" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "BranchRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "invitedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salon_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "salon_members_salonId_userId_key" ON "salon_members"("salonId", "userId");

-- CreateIndex
CREATE INDEX "salon_members_userId_status_idx" ON "salon_members"("userId", "status");

-- CreateIndex
CREATE INDEX "salon_members_salonId_status_idx" ON "salon_members"("salonId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "salon_invitations_tokenHash_key" ON "salon_invitations"("tokenHash");

-- CreateIndex
CREATE INDEX "salon_invitations_salonId_status_idx" ON "salon_invitations"("salonId", "status");

-- CreateIndex
CREATE INDEX "salon_invitations_email_status_idx" ON "salon_invitations"("email", "status");

-- AddForeignKey
ALTER TABLE "salon_members" ADD CONSTRAINT "salon_members_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "salons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_members" ADD CONSTRAINT "salon_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_invitations" ADD CONSTRAINT "salon_invitations_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "salons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every live staff row becomes an ACTIVE STYLIST member of its salon.
INSERT INTO "salon_members" ("id", "salonId", "userId", "role", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, s."salonId", s."userId", 'STYLIST', 'ACTIVE', s."createdAt", CURRENT_TIMESTAMP
FROM "staff" s
WHERE s."isDeleted" = false
ON CONFLICT ("salonId", "userId") DO NOTHING;
