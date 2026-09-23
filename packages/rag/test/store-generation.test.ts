import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ChunkResult } from '../src/strategies/types';

const { tx, transaction } = vi.hoisted(() => {
  const tx = {
    $queryRawUnsafe: vi.fn(), $executeRawUnsafe: vi.fn(),
    indexGeneration: { create: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    knowledgeBase: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
    document: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
    sourceVersion: { upsert: vi.fn() }, chunk: { findMany: vi.fn() },
  };
  return { tx, transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) };
});
vi.mock('@aichat/db', () => ({ prisma: { ...tx, $transaction: transaction } }));
import {
  activateGeneration, createGeneration, ensureSourceVersion, getDocumentChunks,
  retireGeneration, rollbackToGeneration, storePlan,
} from '../src/store';

const plan: ChunkResult[] = [{ key: 'one', parentId: null, kind: 'STANDALONE', ordinal: 0,
  start: 0, end: 4, text: 'text', headingPath: [] }];
const vectors = [Array<number>(1024).fill(0.1)];
const generation = (id: string, status = 'BUILDING') => ({ id, kbId: 'kb', status,
  documentCount: 1, chunkCount: 1, activatedAt: status === 'RETIRED' ? new Date(0) : null });

beforeEach(() => {
  vi.resetAllMocks();
  transaction.mockImplementation(async callback => callback(tx));
  tx.$queryRawUnsafe.mockImplementation(async (sql: string) => sql.includes('count(DISTINCT')
    ? [{ documentCount: 1, chunkCount: 1 }] : [{ id: 'doc' }]);
  tx.$executeRawUnsafe.mockResolvedValue(1);
  tx.document.findUniqueOrThrow.mockResolvedValue({ id: 'doc', kbId: 'kb', sourceVersionId: 'source' });
  tx.knowledgeBase.findUniqueOrThrow.mockResolvedValue({ id: 'kb', activeGenerationId: null });
  tx.indexGeneration.findUnique.mockResolvedValue(generation('g1'));
  tx.indexGeneration.findUniqueOrThrow.mockResolvedValue(generation('g1'));
  tx.sourceVersion.upsert.mockResolvedValue({ id: 'source', documentId: 'doc', kbId: 'kb' });
});

it('creates a BUILDING generation, stores scoped chunks and activates before a scoped read', async () => {
  tx.indexGeneration.create.mockResolvedValue(generation('g1'));
  const created = await createGeneration('kb', { strategy: 'fixed' });
  expect(tx.indexGeneration.create).toHaveBeenCalledWith({ data: { kbId: 'kb', status: 'BUILDING', configSnapshot: { strategy: 'fixed' } } });
  await storePlan('doc', 1, 'worker', plan, vectors, created.id);
  const insert = tx.$executeRawUnsafe.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO "Chunk"'))!;
  expect(insert[0]).toContain('"generationId"');
  expect(insert.slice(-2)).toEqual(['kb', 'g1']);
  expect(tx.$executeRawUnsafe.mock.calls.some(([sql]) => String(sql).includes('DELETE'))).toBe(false);
  await activateGeneration('kb', 'g1');
  expect(tx.knowledgeBase.update).toHaveBeenCalledWith({ where: { id: 'kb' }, data: { activeGenerationId: 'g1' } });
  await getDocumentChunks('doc', 'g1');
  expect(tx.chunk.findMany).toHaveBeenCalledWith({ where: { documentId: 'doc', generationId: 'g1' }, orderBy: { ordinal: 'asc' } });
});

it('preserves old chunks on a new build and switches back to a previously activated generation', async () => {
  tx.knowledgeBase.findUniqueOrThrow.mockResolvedValue({ id: 'kb', activeGenerationId: 'g1' });
  tx.indexGeneration.findUniqueOrThrow.mockResolvedValue(generation('g2'));
  await storePlan('doc', 1, 'worker', plan, vectors, 'g2');
  tx.indexGeneration.findUnique.mockResolvedValue(generation('g2'));
  await activateGeneration('kb', 'g2');
  expect(tx.indexGeneration.update).toHaveBeenCalledWith({ where: { id: 'g1' }, data: { status: 'RETIRED', retiredAt: expect.any(Date) } });
  tx.knowledgeBase.findUniqueOrThrow.mockResolvedValue({ id: 'kb', activeGenerationId: 'g2' });
  tx.indexGeneration.findUnique.mockResolvedValue(generation('g1', 'RETIRED'));
  await rollbackToGeneration('kb', 'g1');
  expect(tx.knowledgeBase.update).toHaveBeenLastCalledWith({ where: { id: 'kb' }, data: { activeGenerationId: 'g1' } });
  expect(tx.indexGeneration.update).toHaveBeenLastCalledWith({ where: { id: 'g1' }, data: { status: 'ACTIVE', activatedAt: expect.any(Date), retiredAt: null } });
  expect(tx.$executeRawUnsafe.mock.calls.some(([sql]) => String(sql).includes('DELETE'))).toBe(false);
});

it.each([{ documentCount: 0, chunkCount: 1 }, { documentCount: 1, chunkCount: 0 }])(
  'rejects count mismatch without touching the active pointer (%j)', async actual => {
    tx.$queryRawUnsafe.mockImplementation(async (sql: string) => sql.includes('count(DISTINCT') ? [actual] : [{ id: 'kb' }]);
    await expect(activateGeneration('kb', 'g1')).rejects.toThrow('GENERATION_COUNT_MISMATCH');
    expect(tx.knowledgeBase.update).not.toHaveBeenCalled();
    expect(tx.indexGeneration.update).not.toHaveBeenCalled();
  },
);

it('reuses the normalized source hash when rechunking changes IDs and ordinals', async () => {
  const first = await ensureSourceVersion('kb', 'doc', 'text');
  await storePlan('doc', 1, 'worker', plan, vectors, 'g1', 'text');
  tx.indexGeneration.findUniqueOrThrow.mockResolvedValue(generation('g2'));
  const second = await ensureSourceVersion('kb', 'doc', 'text');
  await storePlan('doc', 2, 'worker', [{ ...plan[0]!, ordinal: 7 }], vectors, 'g2', 'text');
  expect(first.id).toBe(second.id);
  const inserts = tx.$executeRawUnsafe.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO "Chunk"'));
  expect(inserts[0]![1]).not.toBe(inserts[1]![1]);
  expect(inserts.map(call => call[5])).toEqual([0, 7]);
  for (const [args] of tx.sourceVersion.upsert.mock.calls) {
    expect(args.where).toEqual({ documentId_contentHash: { documentId: 'doc', contentHash: createHash('sha256').update('text').digest('hex') } });
  }
  expect(tx.document.update).toHaveBeenLastCalledWith({ where: { id: 'doc' }, data: { sourceVersionId: 'source' } });
});

it('declares deletion cascades from documents to all-generation chunks, versions and their compile jobs', () => {
  // Database enforcement is verified by the external migration checks, not by a fake deletion here.
  const initial = readFileSync(new URL('../../db/prisma/migrations/20260921010000_rag/migration.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../../db/prisma/migrations/20260923_stage_b_generations/migration.sql', import.meta.url), 'utf8');
  expect(initial).toContain('FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE');
  expect(migration).toContain('"SourceVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE');
  expect(migration).toContain('"CompileJob_sourceVersionId_fkey" FOREIGN KEY ("sourceVersionId") REFERENCES "SourceVersion"("id") ON DELETE CASCADE');
  expect(migration).toContain('"Document_sourceVersionId_fkey" FOREIGN KEY ("sourceVersionId") REFERENCES "SourceVersion"("id") ON DELETE SET NULL');
  expect(migration).not.toMatch(/ALTER\s+(?:TABLE\s+"Chunk"\s+)?(?:COLUMN\s+)?"?embedding/i);
});

it('rejects foreign, failed, and never-activated rollback targets', async () => {
  for (const target of [{ ...generation('g1'), kbId: 'other' }, generation('g1', 'FAILED')]) {
    tx.indexGeneration.findUnique.mockResolvedValue(target);
    await expect(activateGeneration('kb', 'g1')).rejects.toThrow('INVALID_GENERATION');
  }
  tx.indexGeneration.findUnique.mockResolvedValue({ ...generation('g1', 'RETIRED'), activatedAt: null });
  await expect(rollbackToGeneration('kb', 'g1')).rejects.toThrow('INVALID_GENERATION');
  expect(tx.knowledgeBase.update).not.toHaveBeenCalled();
});

it('keeps active retirement atomic and supports unfiltered legacy document reads', async () => {
  tx.knowledgeBase.findUniqueOrThrow.mockResolvedValue({ id: 'kb', activeGenerationId: 'g1' });
  await expect(retireGeneration('kb', 'g1')).rejects.toThrow('ACTIVE_GENERATION_REQUIRES_REPLACEMENT');
  await getDocumentChunks('doc');
  expect(tx.chunk.findMany).toHaveBeenCalledWith({ where: { documentId: 'doc' }, orderBy: { ordinal: 'asc' } });
});
