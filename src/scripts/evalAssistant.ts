/**
 * Offline checks for how the booking assistant reads a typed message - no
 * database, no Gemini.
 *
 *   npm run assistant:eval
 *
 * Each case in data/assistant-cases.json is a message, the state the chat was
 * in (a named fixture), and the action the rules must produce. Add a case
 * whenever a real message is misread, before fixing it, so the fix stays fixed.
 * The clock is pinned by the file's `now`, so "kal" always means the same day.
 *
 * `actionType` is an action type, `null` for "answered with a note, no action"
 * (a day we cannot book, a time that is not free), or "none" for "the rules
 * did not understand it" (the model's turn, or the guided fallback).
 * Exits 1 below a 95% pass rate.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { parseRulesForTest } from "../app/modules/AI-Suggestion/ai.intent";
import { interpret, type Understand } from "../app/modules/Assistant/assistant.nlu";
import { assistantStateSchema } from "../app/modules/Assistant/assistant.state";

// The same places evalAiIntent.ts pins.
const PLACES = [
  ["Mirpur", "Dhaka", "Dhaka", "Dhaka"],
  ["Dhanmondi", "Dhaka", "Dhaka", "Dhaka"],
  ["Gulshan", "Dhaka", "Dhaka", "Dhaka"],
  ["Banani", "Dhaka", "Dhaka", "Dhaka"],
  ["Uttara", "Dhaka", "Dhaka", "Dhaka"],
  ["Khilgaon", "Dhaka", "Dhaka", "Dhaka"],
  ["Agrabad", "Chittagong", "Chittagong", "Chittagong"],
  ["Zindabazar", "Sylhet", "Sylhet", "Sylhet"],
].map(([area, district, city, division]) => ({ area, district, city, division }));

const understand: Understand = async (text) => {
  const { intent, leftover } = parseRulesForTest(text, PLACES);
  return { intent, leftover };
};

type Case = {
  text: string;
  state: string;
  expect: { actionType: string | null; fields?: Record<string, unknown> };
};

const file = JSON.parse(
  readFileSync(join(__dirname, "data", "assistant-cases.json"), "utf8"),
) as { now: string; fixtures: Record<string, unknown>; cases: Case[] };

const at = (value: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>(
    (current, key) => (current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined),
    value,
  );

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const run = async () => {
  const now = new Date(file.now);
  let failures = 0;

  for (const testCase of file.cases) {
    // parse, not readState: a fixture that does not fit must fail loudly, not
    // quietly become a greeting.
    const state = assistantStateSchema.parse(file.fixtures[testCase.state]);
    const result = await interpret(testCase.text, state, understand, now);
    const actionType = result === null ? "none" : (result.action?.type ?? null);

    const problems: string[] = [];
    if (actionType !== testCase.expect.actionType) {
      problems.push(`action: expected ${testCase.expect.actionType}, got ${actionType}`);
    }
    for (const [path, want] of Object.entries(testCase.expect.fields ?? {})) {
      const got = at(result, path);
      if (!same(got, want)) problems.push(`${path}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }

    const label = `${testCase.text}  [${testCase.state}]`;
    if (problems.length) {
      failures += 1;
      console.log(`FAIL  ${label}\n      ${problems.join("\n      ")}\n      got: ${JSON.stringify(result)}`);
    } else {
      console.log(`ok    ${label}`);
    }
  }

  const total = file.cases.length;
  const rate = (total - failures) / total;
  console.log(`\n${total - failures}/${total} passed (${(rate * 100).toFixed(1)}%)`);
  process.exit(rate >= 0.95 ? 0 : 1);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
