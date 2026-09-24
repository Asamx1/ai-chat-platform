import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@aichat/db';
import type { Ontology } from '@aichat/ontology';
import { retrieveEvidence, type VaultContext } from '../src/query.js';
import { extractAssertions, type Llm } from '../src/extract.js';
import { sha256 } from '../src/scan.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const ontology: Ontology = {
  version: '1.0.0', classes: ['A', 'B'].map(id => ({ id, label: id, description: id, abstract: false })), endpointRoles: [],
  relations: [{ id: 'uses', label: 'uses', description: 'uses', domain: ['A'], range: ['B'], symmetric: false, transitive: false, requiresContext: false }],
  aliases: { fields: ['name', 'aliases'], resolutionOrder: ['exact'], similarityMayMerge: false },
};
async function retrievalFixture() {
  const root = await mkdtemp(join(tmpdir(), 'wiki-vector-')); roots.push(root);
  await mkdir(join(root, 'raw/articles'), { recursive: true });
  const text = '# Literal\nautomobile\n# Semantic\na motor vehicle for road transport';
  await writeFile(join(root, 'raw/articles/source.md'), text);
  const source = { id: root, vaultId: 'vault', title: 'Vehicles', filePath: 'raw/articles/source.md', mimeType: 'text/markdown', sha256: sha256(text) };
  const tx = {
    vaultRelease: { findMany: async () => [{ revision: 'rev-001' }] },
    vaultEntityCandidate: { findMany: async () => [] }, vaultAssertion: { findMany: async () => [] },
    vaultSource: { findMany: async () => [source] },
  };
  const db = { $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;
  return { root, db, context: { ontology } as VaultContext };
}
it('ranks semantic sections with equal lexical/cosine weights and lazily caches source vectors', async () => {
  const f = await retrievalFixture();
  const embed = vi.fn(async (texts: string[]) => texts.map(text => text.startsWith('# Literal') ? [-1, 0] : [1, 0]));
  const opts = { vaultPath: f.root, context: f.context, embedding: { embed } };
  const result = await retrieveEvidence('automobile', 'vault', f.db, opts);
  expect(result.evidence.map(e => e.locator)).toEqual([
    { kind: 'section', section: '2:Semantic' }, { kind: 'section', section: '1:Literal' },
  ]);
  await retrieveEvidence('automobile', 'vault', f.db, opts);
  expect(embed.mock.calls.map(call => call[0].length)).toEqual([1, 2, 1]);
});
it('falls back to the original lexical results when embedding fails', async () => {
  const f = await retrievalFixture();
  const result = await retrieveEvidence('automobile', 'vault', f.db, {
    vaultPath: f.root, context: f.context, embedding: { embed: async () => { throw new Error('offline'); } },
  });
  expect(result.evidence.map(e => e.locator)).toEqual([{ kind: 'section', section: '1:Literal' }]);
});
it.each([false, true])('merges batch assertions, evidence and deduplicated candidates (failed middle batch: %s)', async failMiddle => {
  const sections = (failMiddle ? [1, 2, 3] : [1, 3]).map(page => {
    const text = `Alpha uses Beta${page}.` + ' '.repeat(11_000);
    return { text, locator: { kind: 'page' as const, page }, sha256: sha256(text) };
  });
  const llm = vi.fn<Llm>(async ({ prompt }) => {
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as { sections: typeof sections };
    expect(payload.sections).toHaveLength(1);
    const section = payload.sections[0]!;
    const page = section.locator.page;
    if (page === 2) throw new Error('Unterminated string');
    return { entities: [{ name: 'Alpha', type: 'A', aliases: [`alias${page}`] }, { name: `Beta${page}`, type: 'B' }], assertions: [{
      subject: { name: 'Alpha', type: 'A' }, predicate: 'uses', object: { name: `Beta${page}`, type: 'B' },
      polarity: 'positive', conditions: {}, quote: `Alpha uses Beta${page}.`, locatorKind: 'page', locator: section.locator,
    }] };
  });
  const result = await extractAssertions({ needsOcr: false, sections }, { id: 'source', familyId: 'family', sha256: sha256('source') }, ontology, llm);
  expect(llm).toHaveBeenCalledTimes(failMiddle ? 3 : 2);
  expect(result.entities.map(e => e.name)).toEqual(['Alpha', 'Beta1', 'Beta3']);
  expect(result.entities[0]!.aliases).toEqual(['alias1', 'alias3']);
  expect(result.assertions.map(a => a.locator)).toEqual([{ kind: 'page', page: 1 }, { kind: 'page', page: 3 }]);
  expect(result.candidatesIn).toBe(2);
  expect(result.rejected).toEqual(failMiddle ? [expect.objectContaining({ reason: 'BATCH_ERROR: Unterminated string' })] : []);
});
