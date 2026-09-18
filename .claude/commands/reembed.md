---
description: Regenerate salon embeddings after the embedded text or model changed
argument-hint: [--all]
---

Regenerate the pgvector embeddings that back AI salon search.

Decide which form to run:

- `npm run backfill:embeddings` — only salons with no vector yet (new salons).
- `npm run backfill:embeddings -- --all` — every ACTIVE salon. **Required**
  whenever `aiService.buildSalonText`, `EMBEDDING_MODEL`, or
  `EMBEDDING_DIMENSIONS` in `src/app/modules/AI-Suggestion/ai.service.ts`
  changed: existing vectors describe the old text and are not comparable with
  newly generated ones, so search silently degrades if you skip it.

Arguments given: `$ARGUMENTS`

This spends Gemini quota (one embedding request per salon) and needs
`GEMINI_API_KEY` set. Report the succeeded/failed counts and the
"Active salons now searchable" line the script prints, including any failures.
