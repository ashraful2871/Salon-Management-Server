-- Admin Phase 12: job run status. Additive only.

-- CreateEnum
CREATE TYPE "JobRunStatus" AS ENUM ('RUNNING', 'OK', 'FAILED', 'SKIPPED');
