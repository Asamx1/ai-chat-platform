import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@aichat/db';
import { eligiblePromotions, pageSlug, promoteEntity } from '../src/promote.js';
import { publishRevision } from '../src/publish.js';
import { registerSource, sha256 } from '../src/scan.js';

it('uses one pure slug rule for filenames and concept IDs', () => {
  expect(pageSlug(' Alpha Model / V2! ')).toBe('alpha-model--v2');
  expect(pageSlug('中文 概念')).toBe('中文-概念');
  expect(pageSlug('../../A')).toBe('a');
  expect(() => pageSlug('!../')).toThrow('EMPTY_PAGE_SLUG');
});

const testUrl = process.env.AICHAT_TEST_DB_URL;
describe.skipIf(!testUrl)('publish with real PostgreSQL', () => {
  let db: PrismaClient;
  let pool: import('pg').Pool;
  const schema = `wiki_publish_${randomUUID().replaceAll('-', '')}`;
  const roots: string[] = [];
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
      for (const migration of ['20260925000000_vault_tables', '20260925010000_entity_candidate_type']) {
        await connection.query(await readFile(new URL(`../../db/prisma/migrations/${migration}/migration.sql`, import.meta.url), 'utf8'));
      }
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
    db = new Client({ adapter: new PrismaPg({ connectionString: testUrl! }, { schema }) });
  });
  afterAll(async () => {
    await db?.$disconnect();
    if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } }
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });
  async function fixture() {
    const vaultId = randomUUID();
    const root = await mkdtemp(join(tmpdir(), 'wiki-publish-'));
    roots.push(root);
    await mkdir(join(root, 'wiki'), { recursive: true });
    await writeFile(join(root, 'wiki/index.md'), '# Wiki\n\nExisting introduction.\n');
    await writeFile(join(root, 'wiki/log.md'), '# History\n');
    const sources = [];
    for (const title of ['First', 'Second']) sources.push((await registerSource({ title, filePath: `raw/articles/${title}.txt`, sha256: sha256(title), bytes: 5n, mimeType: 'text/plain' }, vaultId, db)).source);
    const first = sources[0]!; const second = sources[1]!;
    const entity = await db.vaultEntityCandidate.create({ data: { vaultId, canonicalName: 'Alpha Model', type: 'Model', status: 'candidate', firstSourceId: first.id, familyIdsJson: [first.familyId, second.familyId, first.familyId], aliasesJson: [] } });
    const single = await db.vaultEntityCandidate.create({ data: { vaultId, canonicalName: 'Beta Task', type: 'Task', status: 'candidate', firstSourceId: first.id, familyIdsJson: [first.familyId, first.familyId], aliasesJson: [] } });
    await db.vaultEntityCandidate.create({ data: { vaultId, canonicalName: 'Source Document', type: 'Source', status: 'candidate', firstSourceId: first.id, familyIdsJson: [first.familyId, second.familyId], aliasesJson: [] } });
    const assertion = await db.vaultAssertion.create({ data: { id: `asr_${randomUUID()}`, vaultId, subjectId: entity.id, objectId: single.id, predicate: 'supports', polarity: true, conditions: '{"dataset":"test"}', status: 'candidate', origin: 'sourced', revision: 'rev-000', ontologyVersion: '1.0.0' } });
    await db.vaultEvidence.create({ data: { vaultId, assertionId: assertion.id, sourceId: first.id, sourceSha256: first.sha256, locatorKind: 'page', locatorJson: '{"kind":"page","page":3}', quote: 'Alpha supports Beta.', stance: 'supports' } });
    return { vaultId, root, entity, single, assertion };
  }
  it('deduplicates families, excludes Source and promotes idempotently', async () => {
    const f = await fixture();
    const eligible = await eligiblePromotions(f.vaultId, db);
    expect(eligible).toHaveLength(1);
    expect(eligible[0]).toMatchObject({ candidate: { id: f.entity.id }, distinctFamilies: 2, relatedAssertions: 1 });
    await expect(promoteEntity(f.single.id, f.vaultId, db)).rejects.toThrow('PROMOTION_INELIGIBLE');
    const first = await promoteEntity(f.entity.id, f.vaultId, db);
    expect(first.pageId).toBe('alpha-model');
    expect((await promoteEntity(f.entity.id, f.vaultId, db)).pageId).toBe(first.pageId);
    expect((await db.vaultAssertion.findUniqueOrThrow({ where: { id: f.assertion.id } })).status).toBe('supported');
    expect(await db.vaultPage.count({ where: { vaultId: f.vaultId } })).toBe(0);
  });
  it('publishes files, index, append-only log, manifest and projections across revisions', async () => {
    const f = await fixture();
    const report = await publishRevision(f.root, f.vaultId, db, { autoGit: false });
    expect(report).toMatchObject({ revision: 'rev-001', promoted: ['alpha-model'], pagesWritten: 3, gitCommit: null, gitSkipped: 'autoGit disabled' });
    const concept = await readFile(join(f.root, 'wiki/concepts/alpha-model.md'), 'utf8');
    expect(concept).toContain(`[${f.assertion.id}]`);
    expect(concept).toContain('page 3');
    expect(concept).toContain('dataset');
    expect(concept).toContain('[[concepts/beta-task|Beta Task]]');
    await expect(readFile(join(f.root, 'wiki/concepts/beta-task.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    const index = await readFile(join(f.root, 'wiki/index.md'), 'utf8');
    expect(index).toContain('Existing introduction.');
    expect(index).toContain('[[concepts/alpha-model]]');
    const log = await readFile(join(f.root, 'wiki/log.md'), 'utf8');
    expect(log.startsWith('# History\n')).toBe(true);
    expect(await db.vaultPage.count({ where: { vaultId: f.vaultId } })).toBe(3);
    const release = await db.vaultRelease.findUniqueOrThrow({ where: { vaultId_revision: { vaultId: f.vaultId, revision: report.revision } } });
    expect(release.status).toBe('committed');
    expect(release.filesJson).toEqual(report.files);
    const manifest = JSON.parse(await readFile(join(f.root, 'wiki/_meta/releases/rev-001.json'), 'utf8'));
    for (const file of report.files) {
      expect(sha256(await readFile(join(f.root, file.path)))).toBe(file.sha256);
      if (!file.path.endsWith('.json')) expect(manifest.files[file.path]).toBe(file.sha256);
    }
    const next = await publishRevision(f.root, f.vaultId, db, { autoGit: false });
    expect(next.revision).toBe('rev-002');
    expect(next.promoted).toEqual([]);
    expect((await readFile(join(f.root, 'wiki/log.md'), 'utf8')).startsWith(log)).toBe(true);
    expect((await readFile(join(f.root, 'wiki/index.md'), 'utf8')).match(/\[\[concepts\/alpha-model\]\]/gu)).toHaveLength(1);
  });
  it('rejects an injected unknown assertion ID without changing baseline or promotions', async () => {
    const f = await fixture();
    await mkdir(join(f.root, 'wiki/concepts'));
    await writeFile(join(f.root, 'wiki/concepts/manual.md'), 'Existing concept [asr_missing]\n');
    await expect(publishRevision(f.root, f.vaultId, db, { autoGit: false })).rejects.toThrow('UNKNOWN_ASSERTION');
    expect(await readFile(join(f.root, 'wiki/concepts/manual.md'), 'utf8')).toBe('Existing concept [asr_missing]\n');
    expect(await readFile(join(f.root, 'wiki/index.md'), 'utf8')).toBe('# Wiki\n\nExisting introduction.\n');
    expect((await db.vaultEntityCandidate.findUniqueOrThrow({ where: { id: f.entity.id } })).status).toBe('candidate');
    expect(await db.vaultRelease.count({ where: { vaultId: f.vaultId, status: 'aborted' } })).toBe(1);
  });
  it('restores replaced files and removes new files when database persistence fails, then retries rev-001', async () => {
    const f = await fixture();
    await pool.query(`ALTER TABLE "${schema}"."VaultPage" ADD CONSTRAINT reject_publish CHECK (title <> 'Alpha Model') NOT VALID`);
    try {
      await expect(publishRevision(f.root, f.vaultId, db, { autoGit: false })).rejects.toThrow('persist');
      expect(await readFile(join(f.root, 'wiki/log.md'), 'utf8')).toBe('# History\n');
      expect(await readFile(join(f.root, 'wiki/index.md'), 'utf8')).toBe('# Wiki\n\nExisting introduction.\n');
      await expect(readFile(join(f.root, 'wiki/concepts/alpha-model.md'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(f.root, 'wiki/_meta/releases/rev-001.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await db.vaultPage.count({ where: { vaultId: f.vaultId } })).toBe(0);
      expect((await db.vaultAssertion.findUniqueOrThrow({ where: { id: f.assertion.id } })).status).toBe('candidate');
      expect(await db.vaultRelease.count({ where: { vaultId: f.vaultId, status: 'aborted' } })).toBe(1);
    } finally { await pool.query(`ALTER TABLE "${schema}"."VaultPage" DROP CONSTRAINT reject_publish`); }
    expect((await publishRevision(f.root, f.vaultId, db, { autoGit: false })).revision).toBe('rev-001');
  });
});
