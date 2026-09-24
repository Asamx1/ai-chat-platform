import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@aichat/db';
import type { Ontology } from '@aichat/ontology';
import { defaultConstraints, reextractAll, type Llm } from '../src/extract.js';
import { retrieveEvidence, type VaultContext } from '../src/query.js';
import { sha256 } from '../src/scan.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const ontology: Ontology = {
  version: '1.0.0', classes: [{ id: 'Concept', label: 'Concept', description: '', abstract: false }],
  endpointRoles: [], relations: [],
  aliases: { fields: ['name', 'aliases'], resolutionOrder: ['exact'], similarityMayMerge: false },
};
async function fixture(text: string) {
  const root = await mkdtemp(join(tmpdir(), 'wiki-coverage-')); roots.push(root);
  await mkdir(join(root, 'raw/articles'), { recursive: true });
  await writeFile(join(root, 'raw/articles/source.md'), text);
  return { root, source: { id: root, vaultId: 'vault', familyId: 'family', title: 'Coverage',
    filePath: 'raw/articles/source.md', mimeType: 'text/markdown', sha256: sha256(text) } };
}

it('only-missing filters before extraction at the default and custom thresholds', async () => {
  const f = await fixture('# Topic\nA supported statement.');
  const sources = [0, 7, 8, 9].map(n => ({ ...f.source, id: String(n) }));
  const count = vi.fn(async ({ where }: { where: { vaultId: string; evidence: { some: { sourceId: string; vaultId: string } } } }) => {
    expect(where.vaultId).toBe('vault');
    expect(where.evidence.some.vaultId).toBe('vault');
    return Number(where.evidence.some.sourceId);
  });
  const db = { vaultSource: { findMany: async () => sources }, vaultAssertion: { count } } as unknown as PrismaClient;
  // Stop at the model boundary, before any replacement transaction.
  const llm = vi.fn<Llm>(async () => { throw new Error('EXTRACTION_REACHED'); });
  const opts = { vaultPath: f.root, ontology, constraints: defaultConstraints, llm };
  for (const [selection, ids] of [
    [{ onlyMissing: true }, ['0', '7']],
    [{ onlyMissing: true, minAssertions: 7 }, ['0']],
    [{ onlyMissing: false }, ['0', '7', '8', '9']],
  ] as const) {
    count.mockClear(); llm.mockClear();
    const reports = await reextractAll('vault', db, { ...opts, ...selection });
    expect(reports.map(r => r.sourceId)).toEqual(ids);
    expect(reports.every(r => r.error === 'EXTRACTION_REACHED')).toBe(true);
    expect(llm).toHaveBeenCalledTimes(ids.length);
    expect(count).toHaveBeenCalledTimes(selection.onlyMissing ? 4 : 0);
  }
});

it('answer clues supplement the top 15 with at most three lexical or weak semantic sections', async () => {
  const f = await fixture([
    ...Array.from({ length: 15 }, (_, i) => `# Main${i}\nneedle needle`),
    '# Lexical\nneedle',
    ...Array.from({ length: 4 }, (_, i) => `# Weak${i}\nhttps://example.test/${i}`),
    '# Noise\nunrelated',
  ].join('\n'));
  const tx = {
    vaultRelease: { findMany: async () => [{ revision: 'rev-001' }] },
    vaultEntityCandidate: { findMany: async () => [] }, vaultAssertion: { findMany: async () => [] },
    vaultSource: { findMany: async () => [f.source] },
  };
  const db = { $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;
  const embed = vi.fn(async (texts: string[]) => texts.map(t => {
    const similarity = t.startsWith('# Weak') ? 0.3 : t.startsWith('# Noise') ? 0.24 : t.startsWith('# Lexical') ? 0 : 1;
    return [similarity, Math.sqrt(1 - similarity ** 2)];
  }));
  const opts = { vaultPath: f.root, context: { ontology } as VaultContext, embedding: { embed } };
  const plain = await retrieveEvidence('needle', 'vault', db, opts);
  expect(plain.evidence).toHaveLength(15);
  const result = await retrieveEvidence('needle URL', 'vault', db, opts);
  expect(result.evidence).toHaveLength(18);
  expect(result.evidence.slice(0, 15)).toEqual(plain.evidence);
  expect(result.evidence.slice(15).filter(e => e.quote.startsWith('# Lexical'))).toHaveLength(1);
  expect(result.evidence.slice(15).filter(e => e.quote.startsWith('# Weak'))).toHaveLength(2);
  expect(result.evidence.every(e => e.derivedFromSection && !e.quote.startsWith('# Noise'))).toBe(true);
  expect(new Set(result.evidence.map(e => e.assertionId)).size).toBe(18);
  expect(embed).toHaveBeenCalled();
});
