import { createHash } from 'node:crypto';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@aichat/db', () => ({ prisma: { apiKey: { findUnique: vi.fn() }, $queryRawUnsafe: vi.fn() } }));
import { prisma } from '@aichat/db';
import { calculateEvidenceMetrics } from '../src/eval/metrics';
import { stratifiedSplit } from '../src/eval/split';
import { runEvaluation } from '../src/eval/runner';
import { generateDatasetCandidates, validateGeneratedCandidates } from '../src/eval/dataset-gen';
import { evalCaseSchema } from '../src/eval/types';
import type { EvidenceAnchor, EvalCase } from '../src/eval/types';

const anchor = (start: number, end: number, document = 'doc'): EvidenceAnchor => ({
  sourceDocumentId: document, sourceVersionId: 'v1', start, end, evidenceText: 'a', evidenceTextHash: 'hash',
});
const item = (id: string, questionType: EvalCase['questionType'] = 'DIRECT_FACT'): EvalCase => evalCaseSchema.parse({
  id, kbId: 'kb', question: `Question ${id}`, referenceAnswer: 'Answer', evidenceAnchors: [anchor(3, 8)],
  evidenceGroups: [[0]], questionType, answerable: true, origin: 'HUMAN_AUTHORED',
  reviewStatus: 'APPROVED', split: 'DEV', reviewedAt: '2026-09-23T00:00:00.000Z', createdAt: '2026-09-23T00:00:00.000Z',
});

afterEach(() => vi.restoreAllMocks());

it('computes all four metrics with span overlap and equivalent evidence groups', () => {
  const units = [
    { sourceDocumentId: 'wrong', sourceVersionId: 'v1', start: 0, end: 5, text: 'x' },
    { sourceDocumentId: 'doc', sourceVersionId: 'v1', start: 7, end: 10, text: 'a' },
    { sourceDocumentId: 'doc2', sourceVersionId: 'v1', start: 20, end: 25, text: 'b' },
  ];
  expect(calculateEvidenceMetrics(units, [anchor(3, 8), anchor(30, 35), anchor(22, 24, 'doc2')], [[0], [1, 2]])).toEqual({
    evidenceHitRateAt5: 1, evidenceCoverageAt5: 1, evidenceMRRAt5: 0.5, documentHitRateAt5: 1,
  });
  expect(calculateEvidenceMetrics([{ ...units[1]!, sourceVersionId: 'old' }], [anchor(3, 8)], [[0]]).evidenceHitRateAt5).toBe(0);
  expect(calculateEvidenceMetrics([{ ...units[1]!, origin: 'WIKI' }], [anchor(3, 8)], [[0]]).evidenceHitRateAt5).toBe(0);
});

it('splits approved cases by type and discloses small cohorts', () => {
  const source = [...Array.from({ length: 10 }, (_, n) => item(String(n))), item('x', 'TABLE_NUMERIC')];
  const result = stratifiedSplit(source);
  expect(result.counts.find(row => row.questionType === 'DIRECT_FACT')).toEqual({ questionType: 'DIRECT_FACT', total: 10, dev: 7, heldout: 3 });
  expect(result.counts.find(row => row.questionType === 'TABLE_NUMERIC')).toEqual({ questionType: 'TABLE_NUMERIC', total: 1, dev: 1, heldout: 0 });
  expect(result.cases.filter(row => row.split === 'HELDOUT')).toHaveLength(3);
});

it('runs a dataset with a mock retriever, fixed budget and stratified report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rag-eval-'));
  try {
    const datasetPath = join(directory, 'dataset.json');
    const reportPath = join(directory, 'report.json');
    await writeFile(datasetPath, JSON.stringify({ version: 'baseline-1', cases: [item('one')] }));
    const retriever = vi.fn(async () => [{ documentId: 'doc', ordinal: 0, name: 'document', text: 'evidence', distance: 0 }]);
    const locate = vi.fn(async () => [{ sourceDocumentId: 'doc', sourceVersionId: 'v1', start: 0, end: 5, text: 'evidence' }]);
    const report = await runEvaluation({ datasetPath, reportPath, userId: 'user', conversationId: 'conversation',
      corpusSnapshotId: 'snapshot', generation: 'g1', sourceVersions: { doc: 'v1' }, commit: 'abc',
      embeddingModel: 'embed', strategy: 'structure', switches: {}, retriever, locate });
    expect(retriever).toHaveBeenCalledWith('user', 'conversation', 'Question one');
    expect(report.summary.metrics.evidenceHitRateAt5).toBe(1);
    expect(report.summary.byQuestionType.DIRECT_FACT?.count).toBe(1);
    expect(report.metadata.datasetVersion).toBe('baseline-1');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('validates generated evidence against the source and fails closed without a key', async () => {
  const source = { kbId: 'kb', sourceDocumentId: 'doc', sourceVersionId: 'v1', text: 'alpha beta' };
  const evidenceText = 'alpha';
  const candidate = { question: 'What?', referenceAnswer: 'alpha', questionType: 'DIRECT_FACT', answerable: true,
    evidenceAnchors: [{ sourceDocumentId: 'doc', sourceVersionId: 'v1', start: 0, end: 5, evidenceText,
      evidenceTextHash: createHash('sha256').update(evidenceText).digest('hex') }], evidenceGroups: [[0]] };
  expect(validateGeneratedCandidates([candidate], source)).toHaveLength(1);
  expect(() => validateGeneratedCandidates([{ ...candidate, evidenceGroups: [[1]] }], source)).toThrow();
  expect(() => validateGeneratedCandidates([{ ...candidate, evidenceAnchors: [{ ...candidate.evidenceAnchors[0], start: 1 }] }], source)).toThrow();
  vi.mocked(prisma.apiKey.findUnique).mockResolvedValueOnce(null);
  expect(await generateDatasetCandidates({ ...source, userId: 'user' })).toEqual([]);
});
