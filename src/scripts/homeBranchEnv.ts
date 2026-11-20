/**
 * Points a script at the Home Service test branch before anything reads the
 * environment: import it FIRST. When `.env.homebranch` exists and its URL
 * contains HOME_CHECK_BRANCH_HOST, DATABASE_URL / DIRECT_URL are set from it
 * (config's dotenv never overrides a variable already set). `--env-db` keeps
 * the `.env` database instead. Prints only the target's host.
 */
import { readBranchTarget } from "./branchTarget";

let target = "the .env database";
/** True once DATABASE_URL points at the test branch; a writing script refuses otherwise. */
export let onHomeBranch = false;

if (!process.argv.includes("--env-db")) {
  // HOME_BRANCH_FILE: another file of the same shape (a local throwaway database).
  const branch = readBranchTarget(process.env.HOME_BRANCH_FILE || ".env.homebranch");
  if (branch.matches && branch.url) {
    process.env.DATABASE_URL = branch.url;
    process.env.DIRECT_URL = branch.url;
    target = `test database (${branch.host})`;
    onHomeBranch = true;
  }
}

console.log(`target: ${target}`);
