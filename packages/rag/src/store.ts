import { randomUUID } from 'node:crypto';
import { prisma } from '@aichat/db';
import type { Slice } from './chunk';
import type { ChunkResult } from './strategies/types';
import { validateVector } from './embed';
import { PermanentRagError } from './parse';
export class LeaseLostError extends Error {}

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
        `INSERT INTO "Chunk" (id,"documentId",ordinal,start,"end",text,kind,embedding)
         VALUES ($1,$2,$3,$4,$5,$6,'STANDALONE',$7::vector(1024))`,
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
): Promise<void> {
  if (!plan.length || plan.length !== vectors.length) throw new PermanentRagError('INVALID_CHUNKS');
  vectors.forEach(validateVector);
  const ids = new Map(plan.map(result => [result.key, randomUUID()]));
  await prisma.$transaction(async tx => {
    await lockDocument(tx, id, attempt, worker);
    await tx.$executeRawUnsafe('DELETE FROM "Chunk" WHERE "documentId"=$1', id);
    const insert = (result: ChunkResult, index: number): Promise<number> =>
      tx.$executeRawUnsafe(
        `INSERT INTO "Chunk" (id,"documentId","parentId",kind,ordinal,start,"end",text,"headingPath",embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector(1024))`,
        ids.get(result.key), id,
        result.parentId == null ? null : ids.get(result.parentId) ?? null,
        result.kind, result.ordinal, result.start, result.end, result.text,
        JSON.stringify(result.headingPath), JSON.stringify(vectors[index]));
    for (const [index, result] of plan.entries()) {
      if (result.kind === 'PARENT') await insert(result, index);
    }
    for (const [index, result] of plan.entries()) {
      if (result.kind !== 'PARENT') await insert(result, index);
    }
    const count = await tx.$executeRawUnsafe(
      `UPDATE "Document" SET status='READY',"chunkCount"=$4,error=NULL,"leaseOwner"=NULL,
       "leaseExpiresAt"=NULL,"updatedAt"=clock_timestamp()
       WHERE id=$1 AND attempt=$2 AND "leaseOwner"=$3 AND status='PROCESSING'
       AND "leaseExpiresAt">clock_timestamp()`, id, attempt, worker, plan.length);
    if (count !== 1) throw new LeaseLostError('LEASE_LOST');
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
         AND c.kind='PARENT' AND c.id = ANY($4)`, userId, conversationId, model, parentIds)
    : [];
  return mergeHits(hits, new Map(rows.map(row => [row.id, row])), budgetBytes);
}
