/**
 * Points a script at the Home Service test branch before anything reads the
 * environment: import it FIRST. When `.env.homebranch` exists and its URL
 * contains HOME_CHECK_BRANCH_HOST, DATABASE_URL / DIRECT_URL are set from it
 * (config's dotenv never overrides a variable already set). `--env-db` keeps
 * the `.env` database instead. Prints only the target's host.
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

const file = path.join(process.cwd(), ".env.homebranch");
let target = "the .env database";

if (!process.argv.includes("--env-db") && fs.existsSync(file)) {
  const env = dotenv.parse(fs.readFileSync(file));
  const url = env.DIRECT_URL || env.DATABASE_URL;
  const host = (env.HOME_CHECK_BRANCH_HOST || "").trim();
  if (url && host && url.includes(host)) {
    process.env.DATABASE_URL = url;
    process.env.DIRECT_URL = url;
    target = `Neon test branch (${host})`;
  }
}

console.log(`target: ${target}`);
