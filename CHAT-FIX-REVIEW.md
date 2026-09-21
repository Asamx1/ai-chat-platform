# Chat chain review — T-20260921-7b55bbdd

Changes: resolver first checks registry id, then modelKey with an enabled provider,
ordered by updatedAt descending. Resolution and quota accounting keep the registry
id; provider requests use the actual model name. Missing models retain HTTP 400;
missing local degradation targets retain HTTP 503, both with readable reasons.
ChatApp reads response errors and SSE payloads, displays run failures with existing
CSS classes, and captures the assistant id before clearing stream state. Newly
created conversations do not fetch history over the live assistant bubble.

## Call sites checked

- `apps/web/src/app/api/models/route.ts`: registry ids in model options.
- `apps/web/src/components/chat/ModelPicker.tsx`: API ids, stored legacy modelKey,
  and hardcoded fallback keys feed ChatApp.
- `apps/web/src/components/chat/ChatApp.tsx`: sends either form as `modelKey` to
  `/api/chat/send`; reads JSON errors and enveloped/legacy SSE events.
- `apps/web/src/app/api/chat/send/route.ts`: validates nonempty identifiers and
  preserves ModelResolutionError status/code/message.
- `apps/web/src/lib/chat-service.ts`: send-time and inline-time resolution use
  the shared resolver; participant snapshot and usage use registry id, config
  snapshot retains the original identifier. Inline provider uses resolved.model.
- `apps/worker/src/runner.ts`: processRun takes configSnapshot.modelKey into
  resolveRunProvider, then the shared resolver. Provider uses resolved.model;
  recordUsage receives resolved.modelId.
- `apps/web/src/components/collab/CollabLauncher.tsx`: MODEL_OPTIONS keys go into
  seats[].modelId, then `/api/collab/run`.
- `apps/web/src/app/api/collab/run/route.ts`: contrary to the brief's description,
  does not directly resolve; persists seats[].modelId as participant modelKey.
- `apps/worker/src/collab-runner.ts`: participant snapshot modelKey passes through
  resolveRunProvider for each seat; accounting uses its canonical registry id.
- `experiments/runners/collab-executor.ts`: writes modelKey participant snapshots
  and invokes processCollabRun. Callers include collab-smoke, exp1-batch and
  exp2-ablation. Their keys therefore use the shared compatibility path.
- `experiments/runners/smoke-real.test.ts`, `exp1-batch.test.ts`,
  `exp2-ablation.test.ts`: single-model experiment branches call Ollama directly
  with model names, bypassing registry resolution intentionally.
- `apps/web/src/app/api/runs/[runId]/events/route.ts` and `src/lib/sse.ts`:
  delta/error are nested in payload; the frontend now matches that envelope.

A modelKey must exist in the registry under an enabled provider for compatibility
lookup to succeed. Hardcoded/experiment models absent from the seed still fail
with an explicit reason; this change does not register or download models.

## Checks actually run

- `pnpm exec vitest run`: failed to start, `Command "vitest" not found` (exit 254).
- `pnpm --filter @aichat/web test`: failed to start, `vitest: not found`,
  `node_modules missing` (exit 1).
- `node --experimental-transform-types tests/chat-fix-smoke.mjs`: 8 passed.
  Real resolver, frontend event/error helpers and Ollama adapter; mocked store
  and HTTP transport. The equivalent temporary harness was also run before
  saving this reproducible copy.
- `node --experimental-transform-types apps/web/test/deepseek-worker.test.mjs`:
  7 passed. Real service/worker/collab runner, mocked resolver/provider/database.
  Updated existing boundary mocks to expose createResolver and resolved.model.
- `git diff --check`: passed.

Added Vitest coverage for legacy/exact ids and canonical quota lookup, real
send-service-resolver 400/503 propagation, SSE/error rendering, and worker provider
model names. These Vitest tests have not executed here. No claim that the existing
121 tests remain green. Browser, real database/provider integration and Next.js
build/type checks were not run. Dependencies were not installed; the local Next.js
guide referenced by apps/web/AGENTS.md is also absent with node_modules.
