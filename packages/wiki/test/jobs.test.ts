import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@aichat/db';
import { enqueueJob, claimNextJob, completeJob, failJob, cancelJob } from '../src/jobs.js';
const testUrl = process.env.AICHAT_TEST_DB_URL;
describe.skipIf(!testUrl)('jobs with real PostgreSQL', () => {
  let db: PrismaClient;
  let pool: import('pg').Pool;
  const schema = `wiki_jobs_${randomUUID().replaceAll('-', '')}`;
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
      for (const migration of ['20260925000000_vault_tables', '20260925010000_entity_candidate_type', '20260927000000_wiki_jobs']) {
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
  it('deduplicates concurrent enqueue by canonical payload within vault and kind', async () => {
    const vaultId = randomUUID();
    const [a, b] = await Promise.all([
      enqueueJob('scan_backlog', { file: 'raw/articles/a.txt', data: { a: 1, b: 2 } }, vaultId, db),
      enqueueJob('scan_backlog', { data: { b: 2, a: 1 }, file: 'raw/articles/a.txt' }, vaultId, db),
    ]);
    expect(a.id).toBe(b.id);
    expect((await enqueueJob('lint_check', { file: 'raw/articles/a.txt', data: { a: 1, b: 2 } }, vaultId, db)).id).not.toBe(a.id);
    expect((await enqueueJob('scan_backlog', { file: 'raw/articles/a.txt', data: { a: 1, b: 2 } }, randomUUID(), db)).id).not.toBe(a.id);
  });
  it('allows only one concurrent claimant and fences completion by attempt', async () => {
    const vaultId = randomUUID();
    await enqueueJob('lint_check', {}, vaultId, db);
    const claims = await Promise.all([claimNextJob(vaultId, db), claimNextJob(vaultId, db)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const job = claims.find(j => j !== null)!;
    expect(job).toMatchObject({ status: 'running', attempts: 1 });
    expect((await completeJob({ id: job.id, attempts: 0 }, {}, db)).count).toBe(0);
    expect((await completeJob(job, { issues: [] }, db)).count).toBe(1);
    expect((await db.wikiJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('done');
    expect((await failJob(job, 'late failure', db)).count).toBe(0);
  });
  it('backs off twice, fails the third attempt and refuses a fourth execution', async () => {
    const vaultId = randomUUID();
    const queued = await enqueueJob('scan_backlog', { sha256: 'fixture' }, vaultId, db);
    let now = new Date('2030-01-01T00:00:00Z');
    for (let attempt = 1; attempt <= 3; attempt++) {
      const job = (await claimNextJob(vaultId, db, { now }))!;
      expect(job.attempts).toBe(attempt);
      await failJob(job, new Error('retry me'), db, now);
      const saved = await db.wikiJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(saved.status).toBe(attempt < 3 ? 'pending' : 'failed');
      expect(saved.error).toBe('retry me');
      expect(await claimNextJob(vaultId, db, { now })).toBeNull();
      expect((await enqueueJob('scan_backlog', { sha256: 'fixture' }, vaultId, db)).id).toBe(queued.id);
      if (attempt < 3) {
        const delay = new Date((saved.payload as { delayUntil: string }).delayUntil);
        expect(delay.getTime() - now.getTime()).toBe(1000 * 2 ** (attempt - 1));
        now = delay;
      } else expect(saved.finishedAt).not.toBeNull();
    }
    expect(await claimNextJob(vaultId, db, { now: new Date('2040-01-01') })).toBeNull();
  });
  it('cancels pending and running jobs without accepting late completion', async () => {
    const vaultId = randomUUID();
    const pending = await enqueueJob('republish', {}, vaultId, db);
    await cancelJob(pending.id, db);
    expect(await claimNextJob(vaultId, db)).toBeNull();
    await enqueueJob('reextract', {}, vaultId, db);
    const running = (await claimNextJob(vaultId, db))!;
    await cancelJob(running.id, db);
    expect((await completeJob(running, {}, db)).count).toBe(0);
  });
});
