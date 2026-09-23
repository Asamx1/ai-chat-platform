import { prisma } from '@aichat/db';
import { normalizeName } from './ontology';
import type { GraphSql } from './ontology';
import type { GraphDatabase } from './store-graph';

/** deadline is an absolute Unix timestamp in milliseconds; the effective budget is capped at 300ms. */
export type HopOptions = { kbId: string; generationId: string; userId: string; conversationId: string; query: string; predicates?: readonly string[]; direction?: 'outgoing' | 'incoming' | 'both'; timeQualifier?: string; conditionQualifier?: string; deadline?: number };
export type HopChunk = { chunkId: string; text: string; entityId: string; evidenceCount: number; priority: number };
export type HopResult = { chunks: HopChunk[]; reason: 'ok' | 'forbidden' | 'timeout' | 'error' };
export function rankChunks(chunks: readonly HopChunk[]): HopChunk[] {
  const sorted = [...chunks].sort((a, b) => a.priority - b.priority || b.evidenceCount - a.evidenceCount || (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0) || (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0));
  const seen = new Set<string>();
  return sorted.filter(c => { if (seen.has(c.chunkId)) return false; seen.add(c.chunkId); return true; }).slice(0, 30);
}
async function neighbors(tx: GraphSql, options: HopOptions, entityId: string): Promise<HopChunk[]> {
  return tx.$queryRawUnsafe<HopChunk[]>(`WITH relations AS (
    SELECT r.*,count(e.id)::int AS n FROM "EntityRelation" r JOIN "RelationEvidence" e ON e."relationId"=r.id
    WHERE r."kbId"=$1 AND r."generationId"=$2
      AND (($4 IN ('outgoing','both') AND r."subjectId"=$3) OR ($4 IN ('incoming','both') AND r."objectId"=$3))
      AND ($5::text[] IS NULL OR r.predicate=ANY($5::text[])) AND ($6::text IS NULL OR r."timeQualifier"=$6)
      AND ($7::text IS NULL OR r."conditionQualifier"=$7)
    GROUP BY r.id ORDER BY n DESC,r."subjectId",r."objectId",r.id LIMIT 10
  ), candidates AS (
    SELECT e."chunkId",r.n,0 AS priority FROM relations r JOIN "RelationEvidence" e ON e."relationId"=r.id
    UNION ALL
    SELECT m."chunkId",r.n,1 AS priority FROM relations r JOIN "EntityMention" m
      ON m."entityId"=CASE WHEN r."subjectId"=$3 THEN r."objectId" ELSE r."subjectId" END
      AND m."kbId"=$1 AND m."generationId"=$2
  ) SELECT c.id AS "chunkId",c.text,$3::text AS "entityId",max(x.n)::int AS "evidenceCount",min(x.priority)::int AS priority
    FROM candidates x JOIN "Chunk" c ON c.id=x."chunkId" JOIN "Document" d ON d.id=c."documentId"
    WHERE c."kbId"=$1 AND c."generationId"=$2 AND d."kbId"=$1 AND d.kind='SOURCE'
    GROUP BY c.id ORDER BY priority,"evidenceCount" DESC,c.id LIMIT 30`,
  options.kbId, options.generationId, entityId, options.direction ?? 'both', options.predicates ? [...options.predicates] : null, options.timeQualifier ?? null, options.conditionQualifier ?? null);
}
export async function oneHop(options: HopOptions, db: GraphDatabase = prisma): Promise<HopResult> {
  const deadline = Math.min(options.deadline ?? Date.now() + 300, Date.now() + 300);
  if (deadline <= Date.now()) { console.warn('[entity-graph] one-hop degraded', 'timeout'); return { chunks: [], reason: 'timeout' }; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = db.$transaction(async tx => {
    await tx.$queryRawUnsafe(`SELECT set_config('statement_timeout',$1,true)`, `${Math.max(1, deadline - Date.now())}ms`);
    const allowed = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT k.id FROM "KnowledgeBase" k JOIN "ConversationKnowledgeBase" ck ON ck."kbId"=k.id
      JOIN "Conversation" c ON c.id=ck."conversationId" JOIN "IndexGeneration" g ON g.id=$4 AND g."kbId"=k.id
      WHERE k.id=$1 AND k."userId"=$2 AND c."ownerId"=$2 AND c.id=$3`, options.kbId, options.userId, options.conversationId, options.generationId);
    if (!allowed.length) return { chunks: [], reason: 'forbidden' as const };
    if (Date.now() >= deadline) return { chunks: [], reason: 'timeout' as const };
    const entities = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT e.id,count(DISTINCT ev.id)::int AS n FROM "Entity" e
      LEFT JOIN "EntityRelation" r ON (r."subjectId"=e.id OR r."objectId"=e.id) AND r."kbId"=$1 AND r."generationId"=$3
      LEFT JOIN "RelationEvidence" ev ON ev."relationId"=r.id
      WHERE e."kbId"=$1 AND EXISTS (SELECT 1 FROM "EntityAlias" a WHERE a."entityId"=e.id AND a.normalized<>'' AND
        (a.normalized=$2 OR (a.normalized ~ '[^ -~]' AND strpos($2,a.normalized)>0) OR
          strpos(' ' || $2 || ' ',' ' || a.normalized || ' ')>0))
      GROUP BY e.id ORDER BY n DESC,e.id LIMIT 5`, options.kbId, normalizeName(options.query).replace(/[\p{P}]/gu, ' '), options.generationId);
    const results = await Promise.allSettled(entities.slice(0, 5).map(e => neighbors(tx, options, e.id)));
    if (results.some(r => r.status === 'rejected')) throw new Error('GRAPH_NEIGHBOR_QUERY_FAILED');
    return { chunks: rankChunks(results.flatMap(r => r.status === 'fulfilled' ? r.value : [])), reason: 'ok' as const };
  }).catch((error: unknown): HopResult => { console.warn('[entity-graph] one-hop error', String(error)); return { chunks: [], reason: Date.now() >= deadline ? 'timeout' : 'error' }; });
  try {
    const result = await Promise.race([work, new Promise<HopResult>(resolve => { timer = setTimeout(() => resolve({ chunks: [], reason: 'timeout' }), Math.max(0, deadline - Date.now())); })]);
    if (result.reason !== 'ok') console.warn('[entity-graph] one-hop degraded', result.reason);
    return result;
  } finally { if (timer) clearTimeout(timer); }
}
