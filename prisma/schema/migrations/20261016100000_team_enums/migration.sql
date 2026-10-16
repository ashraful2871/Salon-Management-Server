-- AlterEnum (its own migration: a new enum value cannot be used in the transaction that adds it)
ALTER TYPE "UserRole" ADD VALUE 'BRANCH_MANAGER';

-- CreateEnum
CREATE TYPE "BranchRole" AS ENUM ('MANAGER', 'RECEPTIONIST', 'STYLIST');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REMOVED');
