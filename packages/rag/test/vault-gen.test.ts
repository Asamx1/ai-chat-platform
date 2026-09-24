import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aichat/db', () => ({ prisma: { apiKey: { findUnique: vi.fn() } } }));
import { prisma } from '@aichat/db';
import { buildVaultGenPrompt, checkVaultQuestionTypeCoverage, generateVaultCandidates, validateVaultCandidates, vaultEvalCaseSchema, vaultQuestionTypeSchema } from '../src/eval/vault-gen';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const text = 'RAG 使用检索增强生成。\n版本 2 需要配置索引。';
const pages = [{ page: 1, text, sha256: hash(text) }];
const sample = () => ({
  id: 'b9f24d50-2b1e-42cc-94fb-711d8d96a989', question: 'RAG 使用什么？', questionType: 'fact' as const,
  answerable: true, referenceAnswer: '检索增强生成。',
  evidenceAnchors: [{ page: 1, evidenceText: 'RAG 使用检索增强生成。', evidenceTextHash: hash('RAG 使用检索增强生成。') }],
  sourceFile: 'RAG的介绍.pdf', sourceSha256: hash('pdf bytes'), reviewStatus: 'DRAFT' as const,
  createdAt: '2026-09-24T00:00:00.000Z',
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('validateVaultCandidates', () => {
  it('accepts exact page slices and valid refusal templates', () => {
    const refusal = { ...sample(), answerable: false, questionType: 'unanswerable', referenceAnswer: '资料未包含该信息，无法据此回答。', evidenceAnchors: [] };
    expect(validateVaultCandidates([sample(), refusal], pages)).toEqual([sample(), refusal]);
  });
  it('rejects text that is not an exact slice even with a matching hash', () => {
    const evidenceText = 'RAG使用检索增强生成。';
    expect(() => validateVaultCandidates([{ ...sample(), evidenceAnchors: [{ page: 1, evidenceText, evidenceTextHash: hash(evidenceText) }] }], pages)).toThrow('INVALID');
  });
  it('rejects wrong hashes and missing page locators', () => {
    for (const change of [{ evidenceTextHash: hash('wrong') }, { page: 2 }]) {
      expect(() => validateVaultCandidates([{ ...sample(), evidenceAnchors: [{ ...sample().evidenceAnchors[0]!, ...change }] }], pages)).toThrow('INVALID');
    }
  });
  it('rejects any evidence on an unanswerable case', () => {
    expect(() => validateVaultCandidates([{ ...sample(), answerable: false }], pages)).toThrow('INVALID');
  });
});

describe('VaultEvalCase schema', () => {
  it('accepts a complete draft and rejects malformed provenance and schema fields', () => {
    expect(vaultEvalCaseSchema.safeParse(sample()).success).toBe(true);
    for (const change of [{ id: 'not-uuid' }, { question: ' ' }, { sourceSha256: 'bad' }, { createdAt: 'yesterday' },
      { reviewStatus: 'APPROVED' }, { questionType: 'unknown' }, { evidenceAnchors: [] }, { questionType: 'out_of_scope' }]) {
      expect(vaultEvalCaseSchema.safeParse({ ...sample(), ...change }).success).toBe(false);
    }
  });
  it('requires a nonempty refusal answer and zero anchors', () => {
    expect(vaultEvalCaseSchema.safeParse({ ...sample(), answerable: false, evidenceAnchors: [], referenceAnswer: '' }).success).toBe(false);
    expect(vaultEvalCaseSchema.safeParse({ ...sample(), answerable: false }).success).toBe(false);
  });
});

it('checks all six types at dataset level, including empty and duplicate-only datasets', () => {
  expect(vaultQuestionTypeSchema.options).toEqual(['fact', 'synonym', 'single_source', 'version_scope', 'unanswerable', 'out_of_scope']);
  const cases = vaultQuestionTypeSchema.options.map(questionType => ({ questionType }));
  expect(checkVaultQuestionTypeCoverage(cases)).toBe(true);
  for (const missing of vaultQuestionTypeSchema.options) expect(checkVaultQuestionTypeCoverage(cases.filter(item => item.questionType !== missing))).toBe(false);
  expect(checkVaultQuestionTypeCoverage([])).toBe(false);
  expect(checkVaultQuestionTypeCoverage([sample(), sample()])).toBe(false);
});

it('includes all types and precomputed exact evidence options in the prompt', () => {
  const prompt = buildVaultGenPrompt(pages, sample());
  for (const type of vaultQuestionTypeSchema.options) expect(prompt).toContain(type);
  expect(prompt).toContain(hash('RAG 使用检索增强生成。'));
  expect(prompt).toContain('4-6');
  expect(prompt).toContain('answerable:false');
});

it('fails closed without a key and never calls the network', async () => {
  vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(null);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  expect(await generateVaultCandidates({ userId: 'user', sourceFile: 'x.pdf', pdfPath: '/unused.pdf' })).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
  vi.mocked(prisma.apiKey.findUnique).mockRejectedValueOnce(new Error('database unavailable'));
  expect(await generateVaultCandidates({ userId: 'user', sourceFile: 'x.pdf', pdfPath: '/unused.pdf' })).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});
