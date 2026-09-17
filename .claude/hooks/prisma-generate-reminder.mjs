/**
 * PostToolUse hook: the Prisma client is generated from prisma/schema/*.prisma,
 * so editing a model without regenerating leaves `tsc` type-checking against the
 * previous schema. Reminds Claude to regenerate, and points at the real
 * migrations directory (prisma/migrations/ is a stale leftover).
 */
let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(input);
    const file =
      payload?.tool_input?.file_path || payload?.tool_response?.filePath || "";

    if (!file.endsWith(".prisma")) return;

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            "A Prisma schema file changed. Run `npx prisma generate` before `npm run build`, " +
            "or tsc will type-check against the old client. Migrations for this repo live in " +
            "prisma/schema/migrations/ (package.json points prisma at ./prisma/schema).",
        },
      })
    );
  } catch {
    // Malformed payload: stay silent rather than break the tool call.
  }
});
