import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@aichat/db';
import type { Ontology } from '@aichat/ontology';
import { extractAssertions, normalizeEntities, defaultConstraints, entityKey, type CandidateSet, type Llm } from '../src/extract.js';
import { parseSource } from '../src/parse.js';
import { registerSource, scanRawDir, scanRawFile, sha256 } from '../src/scan.js';
import { ingestFile, ingestVault } from '../src/ingest.js';

const ontology: Ontology = { version: '1.0.0',
  classes: ['A', 'B'].map(id => ({ id, label: id, description: id, abstract: false })), endpointRoles: [],
  relations: [{ id: 'uses', label: 'uses', description: 'uses', domain: ['A'], range: ['B'], symmetric: false, transitive: false, requiresContext: false }],
  aliases: { fields: ['name', 'aliases'], resolutionOrder: ['exact'], similarityMayMerge: false } };
const quote = 'Alpha uses Beta.';
const locator = { kind: 'offset' as const, start: 0, end: quote.length };
const assertion = { subject: { name: 'Alpha', type: 'A' }, predicate: 'uses', object: { name: 'Beta', type: 'B' },
  polarity: 'positive', conditions: {}, quote, locatorKind: 'offset', locator };
const source = { id: 'src_test', familyId: 'family_test', sha256: sha256(quote) };
const doc = { needsOcr: false, sections: [{ locator, text: quote, sha256: sha256(quote) }] };
const extractStub: Llm = async () => ({ entities: [], assertions: [assertion] });
const normalizeStub: Llm = async () => ({ entities: [] });
let vault: string;
beforeAll(async () => {
  vault = await mkdtemp(join(tmpdir(), 'wiki-ingest-'));
  for (const dir of ['articles', 'papers', 'transcripts', 'assets']) await mkdir(join(vault, 'raw', dir), { recursive: true });
});
afterAll(async () => { if (vault) await rm(vault, { recursive: true, force: true }); });

it('scans supported raw files, ignores assets, and keeps text offset slices <=4000', async () => {
  const text = 'a'.repeat(4100) + '\n' + 'b'.repeat(4050);
  await writeFile(join(vault, 'raw/transcripts/long.txt'), text);
  await writeFile(join(vault, 'raw/assets/ignored.txt'), 'ignored');
  const files = await scanRawDir(vault);
  expect(files.some(f => f.filePath.includes('/assets/'))).toBe(false);
  const file = files.find(f => f.filePath === 'raw/transcripts/long.txt')!;
  expect(file.sha256).toBe(sha256(text));
  expect(file.bytes).toBe(BigInt(Buffer.byteLength(text)));
  const parsed = await parseSource(file, vault);
  expect(parsed.sections.map(s => s.text).join('')).toBe(text);
  for (const section of parsed.sections) {
    expect(section.text.length).toBeLessThanOrEqual(4000);
    if (section.locator.kind === 'offset') expect(text.slice(section.locator.start, section.locator.end)).toBe(section.text);
  }
  await rm(join(vault, 'raw/transcripts/long.txt'));
});
it('preserves repeated markdown headings as distinct locators', async () => {
  const text = '# Topic\nfirst\n# Topic\nsecond\n';
  await writeFile(join(vault, 'raw/articles/headings.md'), text);
  const parsed = await parseSource(await scanRawFile(vault, 'raw/articles/headings.md'), vault);
  expect(parsed.sections).toHaveLength(2);
  expect(parsed.sections[0]!.locator).not.toEqual(parsed.sections[1]!.locator);
  expect(parsed.sections.map(s => s.text).join('')).toBe(text);
  await rm(join(vault, 'raw/articles/headings.md'));
});
function blankPdf(): string {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>'];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}
it('detects a real two-page image-only/blank PDF as pending OCR', async () => {
  await writeFile(join(vault, 'raw/articles/blank.pdf'), blankPdf());
  expect(await parseSource(await scanRawFile(vault, 'raw/articles/blank.pdf'), vault)).toEqual({ needsOcr: true, sections: [] });
});
it('rejects fabricated quotes, wrong locators and wrong hashes, retaining each item', async () => {
  const assertions = [{ ...assertion, quote: 'invented' }, { ...assertion, locator: { ...locator, end: 1 } },
    { ...assertion, quoteSha256: '0'.repeat(64) }];
  const result = await extractAssertions(doc, source, ontology, async () => ({ entities: [], assertions }));
  expect(result.assertions).toHaveLength(0);
  expect(result.rejected).toHaveLength(3);
  expect(result.rejected.every(r => r.reason.includes('INVALID_SOURCE_EVIDENCE'))).toBe(true);
  expect(result.rejected[0]!.item).toEqual(assertions[0]);
});
it('retains invalid relation domains and uncovered relations in rejected', async () => {
  const result = await extractAssertions(doc, source, ontology, async () => ({ entities: [], assertions: [
    { ...assertion, subject: { name: 'Alpha', type: 'B' } }, { ...assertion, predicate: 'unknown_relation' },
  ] }));
  expect(result.assertions).toHaveLength(0);
  expect(result.rejected[0]!.reason).toContain('DOMAIN');
  expect(result.rejected[1]!.reason).toContain('UNKNOWN_RELATION');
});
it('accepts grounded assertions and computes their quote hash without network', async () => {
  const result = await extractAssertions(doc, source, ontology, { llm: extractStub });
  expect(result.assertions).toHaveLength(1);
  expect(result.assertions[0]!.quoteSha256).toBe(sha256(quote));
  expect(result.rejected).toEqual([]);
});

// Isolated schema in a real PostgreSQL test database; never fall back to DATABASE_URL.
// The existing Vault migration supplies tables; cleanup drops only our random schema.
const testUrl = process.env.AICHAT_TEST_DB_URL;
describe.skipIf(!testUrl)('real test database ingestion', () => {
  let db: PrismaClient;
  let pool: import('pg').Pool;
  const schema = `wiki_test_${randomUUID().replaceAll('-', '')}`;
  const vaultId = `test_${randomUUID()}`;
  beforeAll(async () => {
    const [{ Pool }, { PrismaPg }, { PrismaClient: Client }] = await Promise.all([
      import('pg'), import('@prisma/adapter-pg'), import('../../db/src/generated/client.js'),
    ]);
    pool = new Pool({ connectionString: testUrl! });
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query(`CREATE SCHEMA "${schema}"`);
      await connection.query(`SET LOCAL search_path TO "${schema}"`);
      for (const m of ['20260925000000_vault_tables', '20260925010000_entity_candidate_type']) {
        await connection.query(await readFile(new URL(`../../db/prisma/migrations/${m}/migration.sql`, import.meta.url), 'utf8'));
      }
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
    db = new Client({ adapter: new PrismaPg({ connectionString: testUrl! }, { schema }) });
  });
  afterAll(async () => {
    await db?.$disconnect();
    if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } }
  });
  it('rejects duplicate hashes without writes and treats changed content as one source family', async () => {
    const file = { filePath: 'raw/articles/version.txt', title: 'Same Title', sha256: sha256('v1'), bytes: 2n, mimeType: 'text/plain' };
    const first = await registerSource(file, vaultId, db);
    const duplicate = await registerSource(file, vaultId, db);
    expect(duplicate.isDuplicate).toBe(true);
    expect(duplicate.source.id).toBe(first.source.id);
    const revised = await registerSource({ ...file, title: 'same title', sha256: sha256('v2') }, vaultId, db);
    expect(revised.isDuplicate).toBe(false);
    expect(revised.family.id).toBe(first.family.id);
    expect(revised.source.id).not.toBe(first.source.id);
    expect(await db.vaultSourceFamily.count({ where: { vaultId } })).toBe(1);
    expect(await db.vaultSource.count({ where: { vaultId } })).toBe(2);
    const simultaneous = await Promise.all([registerSource(file, vaultId, db), registerSource(file, vaultId, db)]);
    expect(simultaneous.every(r => r.isDuplicate)).toBe(true);
  });
  it('merges exact aliases but keeps same-name different-type entities and deduplicates family IDs', async () => {
    const registered = await registerSource({ filePath: 'raw/articles/entities.txt', title: 'Entities', sha256: sha256('entities'), bytes: 8n, mimeType: 'text/plain' }, vaultId, db);
    const candidates: CandidateSet = { source: registered.source, assertions: [], rejected: [], candidatesIn: 0, entities: [
      { name: 'Alpha', type: 'A', aliases: ['AL PH A', 'Alias'], context: {} },
      { name: 'Alias', type: 'A', aliases: [], context: {} }, { name: 'Alpha', type: 'B', aliases: [], context: {} },
    ] };
    const fallback: Llm = async () => { throw new Error('offline'); };
    const result = await normalizeEntities(candidates, vaultId, { db, llm: fallback });
    expect(result.entitiesCreated).toBe(2);
    expect(result.entitiesMerged).toBe(1);
    expect(result.ids.get(entityKey('A', 'Alpha'))).toBe(result.ids.get(entityKey('A', 'Alias')));
    expect(result.ids.get(entityKey('A', 'Alpha'))).not.toBe(result.ids.get(entityKey('B', 'Alpha')));
    await normalizeEntities(candidates, vaultId, { db, llm: normalizeStub });
    let row = await db.vaultEntityCandidate.findUniqueOrThrow({ where: { id: result.ids.get(entityKey('A', 'Alpha'))! } });
    expect(row.familyIdsJson).toEqual([registered.family.id]);
    const another = await registerSource({ filePath: 'raw/articles/second.txt', title: 'Another family', sha256: sha256('second'), bytes: 6n, mimeType: 'text/plain' }, vaultId, db);
    await normalizeEntities({ ...candidates, source: another.source }, vaultId, { db, llm: normalizeStub });
    row = await db.vaultEntityCandidate.findUniqueOrThrow({ where: { id: row.id } });
    expect(row.familyIdsJson).toEqual([registered.family.id, another.family.id]);
  });
  it('runs ingestFile end to end, skips duplicates before LLM, and persists OCR state in the report', async () => {
    await writeFile(join(vault, 'raw/articles/full.txt'), quote);
    const llm = vi.fn(extractStub);
    const opts = { vaultId, db, ontology, constraints: defaultConstraints, llm, normalizeLlm: normalizeStub };
    const report = await ingestFile(vault, 'raw/articles/full.txt', opts);
    expect(report.errors).toEqual([]);
    expect(report.state).toBe('ingested');
    expect(report.assertionsAccepted).toHaveLength(1);
    expect(report.candidatesIn).toBe(1);
    expect(report.candidatesOut).toBe(1);
    const stored = await db.vaultAssertion.findUniqueOrThrow({ where: { id: report.assertionsAccepted[0]! }, include: { evidence: true } });
    expect(stored).toMatchObject({ status: 'candidate', origin: 'sourced', revision: 'rev-000', predicate: 'uses' });
    expect(stored.evidence[0]).toMatchObject({ quote, sourceSha256: sha256(quote), locatorKind: 'offset', sourceId: report.sourceId });
    expect(await db.vaultEntityCandidate.count({ where: { id: { in: [stored.subjectId, stored.objectId!] } } })).toBe(2);
    expect((await ingestFile(vault, 'raw/articles/full.txt', opts)).isDuplicate).toBe(true);
    expect(llm).toHaveBeenCalledTimes(1);
    const ocr = await ingestFile(vault, 'raw/articles/blank.pdf', opts);
    expect(ocr).toMatchObject({ needsOcr: true, state: 'pending-p3-ocr', errors: [] });
    expect(llm).toHaveBeenCalledTimes(1);
  });
  it('rolls back assertions and entity candidates when evidence persistence fails', async () => {
    const isolatedVault = `${vaultId}_rollback`;
    await writeFile(join(vault, 'raw/articles/rollback.txt'), quote);
    await pool.query(`ALTER TABLE "${schema}"."VaultEvidence" ADD CONSTRAINT reject_test_quote CHECK (quote <> 'Alpha uses Beta.') NOT VALID`);
    try {
      const report = await ingestFile(vault, 'raw/articles/rollback.txt', { vaultId: isolatedVault, db, ontology, constraints: defaultConstraints, llm: extractStub, normalizeLlm: normalizeStub });
      expect(report.errors[0]?.stage).toBe('persist');
      expect(report.assertionsAccepted).toEqual([]);
      expect(await db.vaultAssertion.count({ where: { vaultId: isolatedVault } })).toBe(0);
      expect(await db.vaultEntityCandidate.count({ where: { vaultId: isolatedVault } })).toBe(0);
    } finally { await pool.query(`ALTER TABLE "${schema}"."VaultEvidence" DROP CONSTRAINT reject_test_quote`); }
  });
  it('continues a batch after one PDF parse failure', async () => {
    await writeFile(join(vault, 'raw/articles/00-broken.pdf'), 'invalid pdf');
    await writeFile(join(vault, 'raw/articles/zz-good.txt'), quote);
    const reports = await ingestVault(vault, { vaultId: `${vaultId}_batch`, db, ontology, constraints: defaultConstraints, llm: extractStub, normalizeLlm: normalizeStub });
    expect(reports.find(r => r.file.endsWith('00-broken.pdf'))?.errors[0]?.stage).toBe('parse');
    expect(reports.find(r => r.file.endsWith('zz-good.txt'))?.state).toBe('ingested');
  });
});
