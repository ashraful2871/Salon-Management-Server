---
description: Type-check the project the way CI does (prisma generate + tsc) and report real errors
---

This repo has no test suite or linter — `tsc` under `strict` is the only
automated verification.

1. Run `npx prisma generate` (the client must match `prisma/schema/*.prisma`, or
   tsc reports phantom errors against a stale client).
2. Run `npm run build`.
3. Report the actual compiler output. If it fails, fix the errors and re-run
   until it passes; do not report success on a failing build.

Do not add a test framework, linter, or formatter unless I ask for one.
