import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@aichat/db', () => ({ prisma: {} }));
import { ablationArms, runAblation } from '../src/eval/ablation';

afterEach(() => vi.restoreAllMocks());

it('builds five frozen arms with independent retrieval switches', () => {
  const arms = ablationArms();
  expect(arms.map(arm => arm.name)).toEqual(['baseline', 'semantic', 'wiki', 'graph', 'combined']);
  expect(arms.map(arm => arm.strategy)).toEqual(['structure', 'semantic', 'structure', 'structure', 'semantic']);
  expect(arms.map(arm => arm.retrieveOptions.includeKinds)).toEqual([
    ['SOURCE'], ['SOURCE'], ['SOURCE', 'WIKI_SUMMARY'], ['SOURCE'], ['SOURCE', 'WIKI_SUMMARY']]);
  expect(arms.map(arm => arm.retrieveOptions.graphWeight)).toEqual([0, 0, 0, 0.35, 0.35]);
  expect(Object.isFrozen(arms)).toBe(true);
  expect(arms.every(arm => Object.isFrozen(arm) && Object.isFrozen(arm.retrieveOptions) && Object.isFrozen(arm.switches))).toBe(true);
});

it('runs all arms in one process, injects switches, and reports regressions with costs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rag-ablation-'));
  try {
    const datasetPath = join(directory, 'dataset.json');
    const now = new Date().toISOString();
    await writeFile(datasetPath, JSON.stringify({ version: 'fixed-v1', cases: [{ id: 'q', kbId: 'kb', question: 'Question',
      referenceAnswer: 'answer', evidenceAnchors: [{ sourceDocumentId: 'doc', sourceVersionId: 'v1', start: 0, end: 6,
        evidenceText: 'answer', evidenceTextHash: 'hash' }], evidenceGroups: [[0]], questionType: 'DIRECT_FACT',
      answerable: true, origin: 'HUMAN_AUTHORED', reviewStatus: 'APPROVED', split: 'DEV', reviewedAt: now, createdAt: now }] }));
    const seen: unknown[] = [];
    const report = await runAblation({ datasetPath, kbId: 'kb', userId: 'user', conversationId: 'conversation',
      corpusSnapshotId: 'snapshot', generations: { baseline: 'g0', semantic: 'g1', wiki: 'g0', graph: 'g0', combined: 'g1' },
      sourceVersions: { doc: 'v1' }, commit: 'commit', embeddingModel: 'embed',
      retriever: async (_user, _conversation, _question, options) => {
        seen.push(options);
        return options.switches?.graph ? [] : [{ documentId: 'doc', ordinal: 0, name: 'doc', text: 'answer', distance: 0 }];
      },
      locate: async hits => hits.map(() => ({ sourceDocumentId: 'doc', sourceVersionId: 'v1', start: 0, end: 6, text: 'answer' })),
      cost: async () => ({ usd: 0.1, inputTokens: 10, outputTokens: 5, unknownCostCount: 0 }) });
    expect(seen).toHaveLength(5);
    expect(seen.map((options: any) => options.switches)).toEqual([
      { wiki: false, graph: false }, { wiki: false, graph: false }, { wiki: true, graph: false },
      { wiki: false, graph: true }, { wiki: true, graph: true }]);
    expect(report.rows[3]?.degradedQuestions).toEqual([{ id: 'q', baseline: 1, arm: 0 }]);
    expect(report.rows[0]?.byQuestionType?.DIRECT_FACT?.count).toBe(1);
    expect(report.rows[0]?.cost?.usd).toBe(0.1);
    expect(report.rows[0]?.meanLatencyMs).toBeGreaterThanOrEqual(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
