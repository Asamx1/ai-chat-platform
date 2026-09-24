# Wiki ingestion

`scan.ts` → `parse.ts` → `extract.ts` → `ingest.ts` writes source versions,
entity candidates, candidate assertions and evidence. It never writes Wiki pages
or publishes revisions. Assertions remain `candidate / sourced / rev-000`.

CLI: `scripts/ingest-vault.mts`, using the repository TypeScript runner.
Arguments: `--vault` (default `/mnt/d/wiki-vault`), optional `--file`,
`--vault-id` (default `default`), optional `--user-id`, optional `--out`.
The script loads `.env` from its working directory. It reads `DATABASE_URL`,
`ENCRYPTION_KEY`, and `AICHAT_USER_ID` (unless `--user-id` is supplied). The user ID
selects that user's stored DeepSeek key; it never chooses another user's key.
`INGEST_REPORT_OUT` overrides the default repository
`docs/eval/ingest-report-<UTC timestamp>.json`. Stdout contains the same JSON report
array. File errors produce exit code 1 after saving the batch report.

LLM injection (no network required in tests):

```ts
type Llm = (request: { system: string; prompt: string }) => Promise<unknown>;
extractAssertions(doc, source, ontology, { llm, constraints, userId });
normalizeEntities(candidates, vaultId, { llm, db });
ingestFile(vaultPath, relPath, { llm, normalizeLlm, db, ontology, constraints });
```

The extraction LLM returns `{ entities, assertions }`; each assertion carries
`subject: {name,type}`, `predicate`, `object: {name,type}` or `value`, `polarity`,
`conditions`, `quote`, `locatorKind`, and `locator`. Quote hashes are computed
locally; an optional supplied `quoteSha256` must match. Locators identify exact
parser sections. TXT offsets are zero-based UTF-16 character offsets, end-exclusive,
with chunks aligned to newline boundaries where possible and at most 4000 characters.
Markdown headings have ordinal-prefixed section IDs so repeated headings stay distinct.

The normalization LLM returns `{entities:[{name,type,canonicalName}]}`. Only
choices already present in the exact name/alias component are accepted. A failed
or malformed qwen response falls back to NFKC, lowercase, whitespace removal,
and exact alias matching. Similarity alone never creates an alias.

Schema compatibility:

- `VaultSourceFamily` counts independent sources; each revised hash creates a
  `VaultSource` in the existing family. A duplicate returns without updating rows.
- The existing entity unique key omits type. New `canonicalName` values therefore
  use the stable JSON tuple `[type, normalizedName]`; readable names remain in
  `aliasesJson`. Existing plain canonical names are also matched. Different types
  never merge. Family IDs are deduplicated under a per-vault transaction lock.
- Source tables have no ingest/OCR status column. `pending-p3-ocr` and stage errors
  are retained in the saved report. Registration remains committed if parsing or
  later stages fail; per the requested duplicate behavior a repeated hash skips.
  This package does not implement failed-source retries or an OCR queue.
- Entity candidates, assertions and evidence commit in one transaction. LLM calls
  finish before that transaction starts. Numeric metadata is preserved in conditions.
  Ontology violations (including unknown relations) remain in `assertionsRejected`.

The root Vitest include explicitly lists `test/ingest.test.ts`. Pure tests never
contact a model. DB tests require `AICHAT_TEST_DB_URL`, create a random schema with
the existing Vault migration, and drop only that schema afterward. They never
fall back to the application database; without the test URL the DB suite is skipped.
The existing Prisma client must have been generated from the current Vault schema.

Dependencies: `@aichat/db`, `@aichat/contracts`, `@aichat/ontology`,
`@aichat/crypto` (workspace), `zod` 4.1.5, `pdfjs-dist` 5.4.296,
`dotenv` ^17.4.2. Development: `@types/node` ^24, `@prisma/adapter-pg`
^7.10.0, `pg` ^8.23.0, `@types/pg` ^8.23.1 (isolated real-database tests).
