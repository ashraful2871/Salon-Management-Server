/**
 * Reads a test-branch env file (the `.env.homebranch` shape: DIRECT_URL or
 * DATABASE_URL plus HOME_CHECK_BRANCH_HOST). Pure: it never touches
 * process.env, so a script can probe the branch while still reading the `.env`
 * database. `homeBranchEnv.ts` uses it to redirect a whole script.
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

export type BranchTarget = {
  /** Absolute path of the file that was looked for. */
  file: string;
  exists: boolean;
  url?: string;
  host: string;
  /** True when the URL contains the host filter: the URL is safe to use. */
  matches: boolean;
};

export const readBranchTarget = (fileName = ".env.homebranch"): BranchTarget => {
  const file = path.resolve(process.cwd(), fileName);
  if (!fs.existsSync(file)) return { file, exists: false, host: "", matches: false };
  const env = dotenv.parse(fs.readFileSync(file));
  const url = env.DIRECT_URL || env.DATABASE_URL || undefined;
  const host = (env.HOME_CHECK_BRANCH_HOST || "").trim();
  return { file, exists: true, url, host, matches: Boolean(url && host && url.includes(host)) };
};
