/**
 * Import FIRST in `verify:referral`. `homeBranchEnv` points the script at the
 * test branch when `.env.homebranch` (or HOME_BRANCH_FILE) matches its
 * HOME_CHECK_BRANCH_HOST. Otherwise DATABASE_URL / DIRECT_URL are set to an
 * address nothing listens on, before config or Prisma can read `.env`: the
 * script can then only run its pure part, and can never reach the live DB.
 */
import { onHomeBranch } from "./homeBranchEnv";
import { readBranchTarget } from "./branchTarget";

export const OFFLINE_URL = "postgresql://offline:offline@127.0.0.1:1/offline";
export const branch = readBranchTarget(process.env.HOME_BRANCH_FILE || ".env.homebranch");

if (!onHomeBranch) {
  process.env.DATABASE_URL = OFFLINE_URL;
  process.env.DIRECT_URL = OFFLINE_URL;
}

export { onHomeBranch };
