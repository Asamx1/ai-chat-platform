import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@aichat/db';
import type { Prisma } from '@aichat/db';
import type { Slice } from './chunk';
import type { ChunkResult } from './strategies/types';
import { validateVector } from './embed';
import { PermanentRagError } from './parse';
export class LeaseLostError extends Error {}


export function createGeneration(kbId: string, configSnapshot: Prisma.InputJsonObject): Promise<unknown> {
  return prisma.indexGeneration.create({ data: { kbId, configSnapshot, status: 'BUILDING' } }) as Promise<unknown>;
}

async function lockKb(tx: Prisma.TransactionClient, kbId: string): Promise<void> {
  const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
    'SELECT id FROM "KnowledgeBase" WHERE id=$1 FOR UPDATE', kbId);
  if (!rows.length) throw new Error('KB_NOT_FOUND');
}

async function switchGeneration(kbId: string, generationId: string, rollback: boolean): Promise<void> {
  await prisma.$transaction(async tx => {
    await lockKb(tx, kbId);
    await tx.$queryRawUnsafe('SELECT id FROM "IndexGeneration" WHERE id=$1 FOR UPDATE', generationId);
    const target = await tx.indexGeneration.findUnique({ where: { id: generationId } });
    if (!target || target.kbId !== kbId ||
        (rollback ? target.status !== 'RETIRED' || target.activatedAt === null : target.status !== 'BUILDING')) {
      throw new Error('INVALID_GENERATION');
    }
    const [actual] = await tx.$queryRawUnsafe<{ documentCount: number; chunkCount: number }[]>(
      `SELECT count(DISTINCT "documentId")::int AS "documentCount", count(*)::int AS "chunkCount"
       FROM "Chunk" WHERE "generationId"=$1 AND "kbId"=$2`, generationId, kbId);
    if (!actual || actual.documentCount !== target.documentCount || actual.chunkCount !== target.chunkCount) {
      throw new Error('GENERATION_COUNT_MISMATCH');
    }
    const kb = await tx.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } });
    const now = new Date();
    if (kb.activeGenerationId) await tx.indexGeneration.update({
      where: { id: kb.activeGenerationId }, data: { status: 'RETIRED', retiredAt: now },
    });
    await tx.indexGeneration.update({ where: { id: generationId },
      data: { status: 'ACTIVE', activatedAt: now, retiredAt: null } });
    await tx.knowledgeBase.update({ where: { id: kbId }, data: { activeGenerationId: generationId } });
  });
}

export function activateGeneration(kbId: string, generationId: string): Promise<void> {
  return switchGeneration(kbId, generationId, false);
}

export function rollbackToGeneration(kbId: string, generationId: string): Promise<void> {
  return switchGeneration(kbId, generationId, true);
}

/** Active generations must be replaced atomically; clearing the pointer would enable legacy reads. */
export async function retireGeneration(kbId: string, generationId: string): Promise<void> {
  await prisma.$transaction(async tx => {
    await lockKb(tx, kbId);
    const kb = await tx.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } });
    if (kb.activeGenerationId === generationId) throw new Error('ACTIVE_GENERATION_REQUIRES_REPLACEMENT');
    const result = await tx.indexGeneration.updateMany({
      where: { id: generationId, kbId, status: { in: ['BUILDING', 'ACTIVE', 'RETIRED'] } },
      data: { status: 'RETIRED', retiredAt: new Date() },
    });
    if (result.count !== 1) throw new Error('INVALID_GENERATION');
  });
}

async function attachSourceVersion(tx: Prisma.TransactionClient, kbId: string, documentId: string, normText: string) {
  const contentHash = createHash('sha256').update(normText).digest('hex');
  const version = await tx.sourceVersion.upsert({
    where: { documentId_contentHash: { documentId, contentHash } },
    create: { kbId, documentId, contentHash, parserVersion: 'v1', normalizerVersion: 'v1' }, update: {},
  });
  await tx.document.update({ where: { id: documentId }, data: { sourceVersionId: version.id } });
  return version;
}

export async function ensureSourceVersion(kbId: string, documentId: string, normText: string) {
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
      'SELECT id FROM "Document" WHERE id=$1 AND "kbId"=$2 FOR UPDATE', documentId, kbId);
    if (!rows.length) throw new Error('DOCUMENT_NOT_FOUND');
    return attachSourceVersion(tx, kbId, documentId, normText);
  });
}

/** Callers resolve and retain the generation once per request. Undefined is the compatibility path. */
export function getDocumentChunks(documentId: string, generationId?: string) {
  return prisma.chunk.findMany({ where: { documentId, ...(generationId === undefined ? {} : { generationId }) },
    orderBy: { ordinal: 'asc' } });
}

async function lockDocument(
  tx: { $queryRawUnsafe<T>(sql: string, ...args: unknown[]): Promise<T> },
  id: string, attempt: number, worker: string,
): Promise<void> {
  const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "Document" WHERE id=$1 AND attempt=$2 AND "leaseOwner"=$3
     AND status='PROCESSING' AND "leaseExpiresAt">clock_timestamp() FOR UPDATE`, id, attempt, worker);
  if (!rows.length) throw new LeaseLostError('LEASE_LOST');
}

export async function store(id: string, attempt: number, worker: string, slices: Slice[], vectors: number[][]): Promise<void> {
  if (!slices.length || slices.length !== vectors.length) throw new PermanentRagError('INVALID_CHUNKS');
  vectors.forEach(validateVector);
  await prisma.$transaction(async tx => {
    await lockDocument(tx, id, attempt, worker);
    await tx.$executeRawUnsafe('DELETE FROM "Chunk" WHERE "documentId"=$1', id);
    for (const [i, slice] of slices.entries()) {
      await tx.$executeRawUnsafe(
        `INSERT INTO "Chunk" (id,"documentId",ordinal,start,"end",text,kind,embedding,"kbId","generationId")
         VALUES ($1,$2,$3,$4,$5,$6,'STANDALONE',$7::vector(1024),
           (SELECT "kbId" FROM "Document" WHERE id=$2),
           (SELECT k."activeGenerationId" FROM "KnowledgeBase" k JOIN "Document" d ON d."kbId"=k.id WHERE d.id=$2))`,
        randomUUID(), id, slice.ordinal, slice.start, slice.end, slice.text, JSON.stringify(vectors[i]));
    }
    const count = await tx.$executeRawUnsafe(
      `UPDATE "Document" SET status='READY',"chunkCount"=$4,error=NULL,"leaseOwner"=NULL,
       "leaseExpiresAt"=NULL,"updatedAt"=clock_timestamp()
       WHERE id=$1 AND attempt=$2 AND "leaseOwner"=$3 AND status='PROCESSING'
       AND "leaseExpiresAt">clock_timestamp()`, id, attempt, worker, slices.length);
    if (count !== 1) throw new LeaseLostError('LEASE_LOST');
  }, { timeout: 25_000 });
}

/**
 * Plan-aware store: writes kind/parentId/headingPath alongside the legacy columns.
 * Parents are inserted first so child rows can reference them; every planned chunk
 * (parents included) must carry a valid 1024-dim vector, keeping the NOT NULL constraint.
 */
export async function storePlan(
  id: string, attempt: number, worker: string, plan: ChunkResult[], vectors: number[][],
  generationId?: string, normText?: string, effectiveChunkStrategy?: string,
): Promise<void> {
  if (!plan.length || plan.length !== vectors.length) throw new PermanentRagError('INVALID_CHUNKS');
  vectors.forEach(validateVector);
  const ids = new Map(plan.map(result => [result.key, randomUUID()]));
  await prisma.$transaction(async tx => {
    await lockDocument(tx, id, attempt, worker);
    const document = await tx.document.findUniqueOrThrow({ where: { id } });
    await lockKb(tx, document.kbId);
    const kb = await tx.knowledgeBase.findUniqueOrThrow({ where: { id: document.kbId } });
    const targetId = generationId ?? kb.activeGenerationId;
    if (targetId) {
      await tx.$queryRawUnsafe('SELECT id FROM "IndexGeneration" WHERE id=$1 FOR UPDATE', targetId);
      const generation = await tx.indexGeneration.findUniqueOrThrow({ where: { id: targetId } });
      if (generation.kbId !== document.kbId || (generationId !== undefined && generation.status !== 'BUILDING')) {
        throw new Error('INVALID_GENERATION');
      }
    }
    if (document.kind !== undefined && document.kind !== 'SOURCE') throw new Error('SOURCE_REQUIRED');
    const sourceVersion = normText !== undefined ? await attachSourceVersion(tx, document.kbId, id, normText) : null;
    if (generationId !== undefined && !sourceVersion && !document.sourceVersionId) throw new Error('SOURCE_VERSION_REQUIRED');
    // Only the compatibility path replaces existing chunks. Explicit builds preserve all old generations.
    if (generationId === undefined) await tx.$executeRawUnsafe('DELETE FROM "Chunk" WHERE "documentId"=$1', id);
    const insert = (result: ChunkResult, index: number): Promise<number> =>
      tx.$executeRawUnsafe(
        `INSERT INTO "Chunk" (id,"documentId","parentId",kind,ordinal,start,"end",text,"headingPath",embedding,"kbId","generationId")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector(1024),$11,$12)`,
        ids.get(result.key), id,
        result.parentId == null ? null : ids.get(result.parentId) ?? null,
        result.kind, result.ordinal, result.start, result.end, result.text,
        JSON.stringify(result.headingPath), JSON.stringify(vectors[index]), document.kbId, targetId);
    for (const [index, result] of plan.entries()) {
      if (result.kind === 'PARENT') await insert(result, index);
    }
    for (const [index, result] of plan.entries()) {
      if (result.kind !== 'PARENT') await insert(result, index);
    }
    const count = await tx.$executeRawUnsafe(
      `UPDATE "Document" SET status='READY',"chunkCount"=$4,"chunkStrategy"=COALESCE($5,"chunkStrategy"),error=NULL,"leaseOwner"=NULL,
       "leaseExpiresAt"=NULL,"updatedAt"=clock_timestamp()
       WHERE id=$1 AND attempt=$2 AND "leaseOwner"=$3 AND status='PROCESSING'
       AND "leaseExpiresAt">clock_timestamp()`, id, attempt, worker, plan.length, effectiveChunkStrategy ?? null);
    if (count !== 1) throw new LeaseLostError('LEASE_LOST');
    const versionId = sourceVersion?.id ?? document.sourceVersionId;
    if (targetId && versionId) await tx.$executeRawUnsafe(
      `INSERT INTO "CompileOutbox" (id,"kbId","documentId","sourceVersionId","generationId","eventType")
       VALUES ($1,$2,$3,$4,$5,'SOURCE_READY') ON CONFLICT DO NOTHING`,
      randomUUID(), document.kbId, id, versionId, targetId);
    if (targetId) await tx.$executeRawUnsafe(
      `UPDATE "IndexGeneration" g SET
       "documentCount"=(SELECT count(DISTINCT "documentId") FROM "Chunk" WHERE "generationId"=g.id),
       "chunkCount"=(SELECT count(*) FROM "Chunk" WHERE "generationId"=g.id) WHERE g.id=$1`, targetId);
  }, { timeout: 25_000 });
}

/** Commit a rebuild task without changing the live Document or active generation. */
export async function storeRebuildPlan(jobId: string, owner: string, sourceVersionId: string,
  plan: ChunkResult[], vectors: number[][]): Promise<void> {
  if (!plan.length || plan.length !== vectors.length) throw new PermanentRagError('INVALID_CHUNKS');
  vectors.forEach(validateVector);
  const ids = new Map(plan.map(result => [result.key, randomUUID()]));
  await prisma.$transaction(async tx => {
    const [job] = await tx.$queryRawUnsafe<{ kbId: string; generationId: string; documentId: string }[]>(`
      SELECT j."kbId",j."generationId",s."documentId" FROM "CompileJob" j
      JOIN "SourceVersion" s ON s.id=j."sourceVersionId"
      JOIN "IndexGeneration" g ON g.id=j."generationId"
      WHERE j.id=$1 AND j."leaseOwner"=$2 AND j."sourceVersionId"=$3 AND j.status='RUNNING'
        AND j."leaseExpiresAt">clock_timestamp() AND g.status='BUILDING' FOR UPDATE OF j,g`,
      jobId, owner, sourceVersionId);
    if (!job) throw new LeaseLostError('LEASE_LOST');
    const [source] = await tx.$queryRawUnsafe<{ id: string }[]>(`
      SELECT id FROM "Document" WHERE id=$1 AND "kbId"=$2 AND kind='SOURCE'
        AND "sourceVersionId"=$3 AND status='READY'`, job.documentId, job.kbId, sourceVersionId);
    if (!source) throw new LeaseLostError('SOURCE_CHANGED');
    for (const [index, result] of plan.entries()) {
      if (result.kind !== 'PARENT') continue;
      await tx.$executeRawUnsafe(`INSERT INTO "Chunk" (id,"documentId","parentId",kind,ordinal,start,"end",text,"headingPath",embedding,"kbId","generationId")
        VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9::vector(1024),$10,$11)`, ids.get(result.key), job.documentId,
        result.kind, result.ordinal, result.start, result.end, result.text, JSON.stringify(result.headingPath),
        JSON.stringify(vectors[index]), job.kbId, job.generationId);
    }
    for (const [index, result] of plan.entries()) {
      if (result.kind === 'PARENT') continue;
      await tx.$executeRawUnsafe(`INSERT INTO "Chunk" (id,"documentId","parentId",kind,ordinal,start,"end",text,"headingPath",embedding,"kbId","generationId")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector(1024),$11,$12)`, ids.get(result.key), job.documentId,
        result.parentId ? ids.get(result.parentId) : null, result.kind, result.ordinal, result.start, result.end,
        result.text, JSON.stringify(result.headingPath), JSON.stringify(vectors[index]), job.kbId, job.generationId);
    }
    await tx.$executeRawUnsafe(`UPDATE "CompileJob" SET status='SUCCEEDED',"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"updatedAt"=clock_timestamp() WHERE id=$1`, jobId);
    await tx.$executeRawUnsafe(`INSERT INTO "CompileOutbox" (id,"kbId","documentId","sourceVersionId","generationId","eventType")
      VALUES ($1,$2,$3,$4,$5,'SOURCE_READY') ON CONFLICT DO NOTHING`, randomUUID(), job.kbId, job.documentId, sourceVersionId, job.generationId);
    await tx.$executeRawUnsafe(`UPDATE "IndexGeneration" g SET "documentCount"=(SELECT count(DISTINCT "documentId") FROM "Chunk" WHERE "generationId"=g.id),
      "chunkCount"=(SELECT count(*) FROM "Chunk" WHERE "generationId"=g.id) WHERE g.id=$1`, job.generationId);
  }, { timeout: 25_000 });
}

/** A retrieved retrieval block (CHILD/STANDALONE) before small-to-big expansion. */
export type ChildHit = {
  chunkId: string;
  documentId: string;
  ordinal: number;
  name: string;
  text: string;
  parentId: string | null;
  distance: number;
};

export type ParentRow = { id: string; documentId: string; ordinal: number; name: string; text: string };

/** A small-to-big hit: the parent text replaces the matched child text when available. */
export type ExpandedHit = {
  chunkId: string;
  documentId: string;
  ordinal: number;
  name: string;
  text: string;
  parentId: string | null;
  distance: number;
  matchedChildIds: string[];
  truncated: boolean;
};

/**
 * Small-to-big read side: dedupe ranked child hits per parent group, replace the child
 * text with the parent text, then trim to a UTF-8 byte budget — the last group that
 * overflows is truncated in place and everything after it is dropped.
 * `hits` must already be ranked; input order is preserved and never re-sorted.
 */
export function mergeHits(
  hits: readonly ChildHit[],
  parents: ReadonlyMap<string, ParentRow>,
  budgetBytes: number,
): ExpandedHit[] {
  const groups = new Map<string, ExpandedHit>();
  for (const hit of hits) {
    const parent = hit.parentId == null ? undefined : parents.get(hit.parentId);
    const key = parent ? parent.id : hit.parentId ?? hit.chunkId;
    const existing = groups.get(key);
    if (existing) {
      existing.matchedChildIds.push(hit.chunkId);
      existing.distance = Math.min(existing.distance, hit.distance);
      continue;
    }
    groups.set(key, parent
      ? {
          chunkId: parent.id, documentId: parent.documentId, ordinal: parent.ordinal, name: parent.name,
          text: parent.text, parentId: null, distance: hit.distance, matchedChildIds: [hit.chunkId], truncated: false,
        }
      : {
          // Missing/unauthorized parent: the child stays valid and is returned as-is.
          chunkId: hit.chunkId, documentId: hit.documentId, ordinal: hit.ordinal, name: hit.name,
          text: hit.text, parentId: hit.parentId, distance: hit.distance, matchedChildIds: [hit.chunkId], truncated: false,
        });
  }
  const merged = [...groups.values()];
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0) return merged;
  const output: ExpandedHit[] = [];
  let used = 0;
  for (const hit of merged) {
    const bytes = Buffer.byteLength(hit.text, 'utf8');
    if (used + bytes <= budgetBytes) {
      used += bytes;
      output.push(hit);
      continue;
    }
    const remaining = budgetBytes - used;
    if (remaining > 0) output.push({ ...hit, text: takeUtf8(hit.text, remaining), truncated: true });
    break;
  }
  return output;
}

function takeUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let length = 0;
  for (const ch of text) {
    const next = bytes + Buffer.byteLength(ch, 'utf8');
    if (next > maxBytes) break;
    bytes = next;
    length += ch.length;
  }
  return text.slice(0, length);
}

/**
 * Fetches authorized parent rows and applies small-to-big merging. Parent lookup keeps
 * the same ownership/conversation/READY/model conditions as vector retrieval and is
 * restricted to PARENT rows, so a dangling cross-document parentId cannot leak text.
 */
export async function expandParentContext(
  userId: string,
  conversationId: string,
  model: string,
  hits: readonly ChildHit[],
  budgetBytes = 4096,
  generationId?: string,
): Promise<ExpandedHit[]> {
  const parentIds = [...new Set(hits.map(hit => hit.parentId).filter((id): id is string => id != null))];
  const rows = parentIds.length
    ? await prisma.$queryRawUnsafe<ParentRow[]>(
      `SELECT c.id,c."documentId",c.ordinal,d.name,c.text FROM "Chunk" c
       JOIN "Document" d ON d.id=c."documentId"
       JOIN "KnowledgeBase" k ON k.id=d."kbId"
       JOIN "ConversationKnowledgeBase" m ON m."kbId"=k.id
       JOIN "Conversation" v ON v.id=m."conversationId"
       WHERE k."userId"=$1 AND v."ownerId"=$1 AND v.id=$2 AND d.status='READY' AND d.model=$3
         AND c.kind='PARENT' AND c.id = ANY($4)
         AND ($5::text IS NULL OR c."generationId"=$5)`, userId, conversationId, model, parentIds, generationId ?? null)
    : [];
  return mergeHits(hits, new Map(rows.map(row => [row.id, row])), budgetBytes);
}
