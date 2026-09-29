import { RETRIEVAL_BUDGET_MS } from './llm-json';
export { RETRIEVAL_BUDGET_MS } from './llm-json';
import { prisma } from '@aichat/db';
import { embed, embeddingModel, validateVector } from './embed';
import { rerank } from './rerank';
import { rewriteQuery } from './rewrite';
import { oneHop, type HopResult } from './graph/one-hop';
export type Hit = { documentId: string; ordinal: number; name: string; text: string; distance: number; headingPath?: string | null; documentKind?: string };
export type Candidate = Hit & { chunkId: string; parentId: string | null; kind: string | null; embedding: string };

/** Rewrite lists contribute their best rank, not extra RRF votes. Ties retain list order. */
function mergeBestRank(lists: Candidate[][]): Candidate[] {
  const merged = new Map<string, { item: Candidate; rank: number }>();
  for (const list of lists) {
    for (const [rank, item] of list.entries()) {
      const prior = merged.get(item.chunkId);
      if (!prior || rank < prior.rank) merged.set(item.chunkId, { item, rank });
    }
  }
  return [...merged.values()].sort((a, b) => a.rank - b.rank).map(entry => entry.item);
}

/** One vote per chunk per list; ranks are one-based. */
export function reciprocalRankFusion<T extends { chunkId: string; distance: number }>(lists: readonly (readonly T[])[], weights: readonly number[] = []): T[] {
  const fused = new Map<string, { item: T; score: number }>();
  for (const [listIndex, list] of lists.entries()) {
    const seen = new Set<string>();
    let rank = 0;
    for (const item of list) {
      if (seen.has(item.chunkId)) continue;
      seen.add(item.chunkId);
      rank += 1;
      const entry = fused.get(item.chunkId) ?? { item, score: 0 };
      entry.score += (weights[listIndex] ?? 1) / (60 + rank);
      fused.set(item.chunkId, entry);
    }
  }
  return [...fused.values()].sort((a, b) => b.score - a.score ||
    a.item.distance - b.item.distance || a.item.chunkId.localeCompare(b.item.chunkId)).map(entry => entry.item);
}

/** Rank-normalized relevance and cosine redundancy, lambda=0.5. Ties retain input order. */
export function maximalMarginalRelevance<T extends { embedding: readonly number[] }>(items: readonly T[], limit = 5): T[] {
  const normalized = items.map(item => {
    const norm = Math.sqrt(item.embedding.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(norm) || norm === 0) throw new Error('INVALID_EMBEDDING');
    return item.embedding.map(value => value / norm);
  });
  const remaining = items.map((item, index) => ({ item, index, vector: normalized[index]! }));
  const selected: typeof remaining = [];
  while (remaining.length && selected.length < limit) {
    let best = 0;
    let bestScore = -Infinity;
    for (const [index, candidate] of remaining.entries()) {
      const relevance = items.length === 1 ? 1 : 1 - candidate.index / (items.length - 1);
      let redundancy = 0;
      for (const prior of selected) {
        if (candidate.vector.length !== prior.vector.length) throw new Error('INVALID_EMBEDDING');
        const cosine = candidate.vector.reduce((sum, value, axis) => sum + value * prior.vector[axis]!, 0);
        redundancy = Math.max(redundancy, Math.min(1, cosine));
      }
      const score = 0.5 * relevance - 0.5 * redundancy;
      if (score > bestScore) { best = index; bestScore = score; }
    }
    const [next] = remaining.splice(best, 1);
    if (next) selected.push(next);
  }
  return selected.map(candidate => candidate.item);
}

const scope = `FROM "Chunk" c JOIN "Document" d ON d.id=c."documentId"
     JOIN "KnowledgeBase" k ON k.id=d."kbId"
     JOIN "ConversationKnowledgeBase" m ON m."kbId"=k.id
     JOIN "Conversation" v ON v.id=m."conversationId"
     WHERE k."userId"=$2 AND v."ownerId"=$2 AND v.id=$3 AND d.status='READY' AND d.model=$4
     AND EXISTS (SELECT 1 FROM jsonb_to_recordset($5::jsonb) AS snapshot(id text, "activeGenerationId" text)
       WHERE snapshot.id=k.id AND (snapshot."activeGenerationId" IS NULL OR c."generationId"=snapshot."activeGenerationId"))`;
const projection = `c."documentId",c.ordinal,d.name,c.text,c."headingPath",d.kind AS "documentKind",c.embedding <=> $1::vector(1024) AS distance`;
const retrievalKinds = ` AND (c.kind IS NULL OR c.kind IN ('CHILD','STANDALONE'))`;

async function beforeDeadline<T>(work: PromiseLike<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('RAG_TIMEOUT')), Math.max(0, deadline - Date.now()));
    })]);
  } finally { clearTimeout(timer); }
}

function hitOnly(hit: Hit): Hit {
  return { documentId: hit.documentId, ordinal: hit.ordinal, name: hit.name, text: hit.text, distance: hit.distance,
    ...(hit.headingPath !== undefined ? { headingPath: hit.headingPath } : {}) };
}

export type GraphPath = { used: boolean; timeoutMs: number; error?: string; entities: number; relations: number };
export type RetrievedHits = Hit[] & { graphPath: GraphPath };
export type RetrieveOptions = { includeKinds?: readonly ('SOURCE' | 'WIKI_SUMMARY' | 'WIKI_ENTITY')[]; graphWeight?: number; candidateQuota?: readonly [number, number, number]; switches?: { wiki?: boolean; graph?: boolean }; generationOverrides?: Readonly<Record<string, string>> };
export function allowedKinds(options?: RetrieveOptions): string[] {
  if (!(options?.switches?.wiki ?? (process.env.RAG_WIKI === 'true')) || process.env.RAG_WIKI === 'false') return ['SOURCE'];
  const requested = options?.includeKinds ?? ['SOURCE'];
  return [...new Set(requested.filter(kind => kind === 'SOURCE' || kind === 'WIKI_SUMMARY' || kind === 'WIKI_ENTITY'))];
}

export function quotaCandidates<T extends { documentId: string; documentKind?: string }>(hits: readonly T[], kinds: readonly string[], limit = 5, quota: readonly number[] = [60, 25, 15]): T[] {
  if (kinds.length === 1) return hits.slice(0, limit);
  const seen = new Set<string>();
  const unique = hits.filter(hit => { const key = `${hit.documentKind ?? 'SOURCE'}:${hit.documentId}`; if (seen.has(key)) return false; seen.add(key); return true; });
  const total = quota.reduce((a, b) => a + Math.max(0, b), 0) || 1;
  const names = ['SOURCE', 'WIKI_SUMMARY', 'WIKI_ENTITY'];
  const caps = names.map((_, i) => Math.floor(limit * Math.max(0, quota[i] ?? 0) / total));
  let left = limit - caps.reduce((a, b) => a + b, 0);
  const remainderOrder = [0, 1, 2].sort((a, b) =>
    (limit * (quota[b] ?? 0) / total % 1) - (limit * (quota[a] ?? 0) / total % 1) || a - b);
  for (const i of remainderOrder) { if (left-- <= 0) break; caps[i]!++; }
  const counts = [0, 0, 0];
  const selected = unique.filter(hit => { const i = names.indexOf(hit.documentKind ?? 'SOURCE'); if (i < 0 || !kinds.includes(names[i]!) || counts[i]! >= caps[i]!) return false; counts[i]!++; return true; });
  return selected.slice(0, limit);
}

async function sourceEvidence(hits: Hit[], userId: string, conversationId: string, snapshot: string, deadline: number): Promise<Hit[]> {
  const result: Hit[] = [];
  for (const hit of hits) {
    if (hit.documentKind !== 'WIKI_SUMMARY' && hit.documentKind !== 'WIKI_ENTITY') { result.push(hitOnly(hit)); continue; }
    try {
    const facts = await beforeDeadline(prisma.$queryRawUnsafe<(Hit & { quote: string; spanStart: number; spanEnd: number })[]>(
      `SELECT s."documentId",s.ordinal,d.name,s.text,f.quote,f."spanStart",f."spanEnd",$1::float AS distance
       FROM "SummaryFact" f JOIN "Document" summary ON summary.id=f."summaryDocumentId"
       JOIN "CompileJob" j ON j."artifactDocumentId"=summary.id
       JOIN "Chunk" s ON s.id=f."sourceChunkId" JOIN "Document" d ON d.id=s."documentId"
       JOIN "KnowledgeBase" k ON k.id=d."kbId" JOIN "ConversationKnowledgeBase" m ON m."kbId"=k.id
       JOIN "Conversation" v ON v.id=m."conversationId"
       WHERE summary.id=$2 AND d.kind='SOURCE' AND d.status='READY' AND d."sourceVersionId"=j."sourceVersionId"
       AND s."generationId"=j."generationId" AND k."userId"=$3 AND v."ownerId"=$3 AND v.id=$4
       AND EXISTS (SELECT 1 FROM jsonb_to_recordset($5::jsonb) AS snap(id text,"activeGenerationId" text)
         WHERE snap.id=k.id AND (snap."activeGenerationId" IS NULL OR s."generationId"=snap."activeGenerationId"))
       ORDER BY f.id LIMIT 5`, hit.distance, hit.documentId, userId, conversationId, snapshot), deadline);
    const entityFacts = hit.documentKind === 'WIKI_ENTITY' ? await beforeDeadline(prisma.$queryRawUnsafe<(Hit & { quote: string; spanStart: number; spanEnd: number })[]>(
      `SELECT s."documentId",s.ordinal,d.name,s.text,e."evidenceText" AS quote,e.start AS "spanStart",e."end" AS "spanEnd",$1::float AS distance
       FROM "CompileJob" j JOIN "Document" wiki ON wiki.id=j."artifactDocumentId" AND wiki.kind='WIKI_ENTITY'
       JOIN "EntityRelation" r ON r."kbId"=j."kbId" AND r."generationId"=j."generationId" AND (r."subjectId"=j."promptVersion" OR r."objectId"=j."promptVersion")
       JOIN "RelationEvidence" e ON e."relationId"=r.id JOIN "Chunk" s ON s.id=e."chunkId" AND s."generationId"=j."generationId"
       JOIN "Document" d ON d.id=s."documentId" AND d.id=e."documentId" AND d."sourceVersionId"=e."sourceVersionId"
       JOIN "KnowledgeBase" k ON k.id=d."kbId" JOIN "ConversationKnowledgeBase" m ON m."kbId"=k.id
       JOIN "Conversation" v ON v.id=m."conversationId"
       WHERE wiki.id=$2 AND wiki."kbId"=k.id AND j."kbId"=k.id AND d.kind='SOURCE' AND d.status='READY'
         AND k."userId"=$3 AND v."ownerId"=$3 AND v.id=$4
         AND EXISTS (SELECT 1 FROM jsonb_to_recordset($5::jsonb) AS snap(id text,"activeGenerationId" text)
           WHERE snap.id=k.id AND snap."activeGenerationId"=j."generationId")
       ORDER BY r.id,e.id LIMIT 5`, hit.distance, hit.documentId, userId, conversationId, snapshot), deadline) : [];
    const valid = [...facts, ...entityFacts].find(f => f.spanStart >= 0 && f.spanEnd > f.spanStart &&
      f.text.slice(f.spanStart, f.spanEnd) === f.quote);
    if (valid) result.push({ documentId: valid.documentId, ordinal: valid.ordinal, name: valid.name,
      text: valid.quote, distance: hit.distance });
    } catch (error) { console.warn('[rag] wiki provenance unavailable', String(error)); }
  }
  const seen = new Set<string>();
  return result.filter(hit => { const key = `${hit.documentId}:${hit.ordinal}:${hit.text}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

export async function retrieve(userId: string, conversationId: string, query: string, options?: RetrieveOptions): Promise<RetrievedHits> {
  const deadline = Date.now() + RETRIEVAL_BUDGET_MS;
  const generations = await beforeDeadline(prisma.knowledgeBase.findMany({
    where: { userId, conversations: { some: { conversationId, conversation: { ownerId: userId } } } },
    select: { id: true, activeGenerationId: true },
  }), deadline);
  if (options?.generationOverrides) for (const kb of generations) {
    const override = options.generationOverrides[kb.id];
    if (!override) continue;
    const valid = await beforeDeadline(prisma.indexGeneration.findFirst({ where: { id: override, kbId: kb.id,
      status: { in: ['BUILDING', 'ACTIVE', 'RETIRED'] } }, select: { id: true } }), deadline);
    if (!valid) throw new Error('INVALID_GENERATION_OVERRIDE');
    kb.activeGenerationId = override;
  }
  const snapshot = JSON.stringify(generations);
  const graphEnabled = (options?.switches?.graph ?? (process.env.RAG_GRAPH === 'true')) && process.env.RAG_GRAPH !== 'false';
  const graphBudget = Math.max(0, Math.min(300, deadline - Date.now() - 1));
  const graphDeadline = Date.now() + graphBudget;
  const graphWork: Promise<PromiseSettledResult<HopResult>[]> = graphEnabled && graphBudget > 0
    ? Promise.allSettled(generations.filter(g => g.activeGenerationId).map(g => oneHop({
      kbId: g.id, generationId: g.activeGenerationId!, userId, conversationId, query,
      deadline: graphDeadline,
    }))) : Promise.resolve([]);
  const graphState: GraphPath = { used: false, timeoutMs: graphEnabled ? graphBudget : 0, entities: 0, relations: 0 };
  const attach = (hits: Hit[]): RetrievedHits => Object.defineProperty(hits, 'graphPath', { value: { ...graphState }, enumerable: false }) as RetrievedHits;
  const graphCandidates = async (): Promise<Candidate[]> => {
    if (!graphEnabled || graphBudget <= 0) return [];
    let settled: PromiseSettledResult<HopResult>[];
    try { settled = await beforeDeadline(graphWork, graphDeadline); }
    catch { graphState.error = 'timeout'; return []; }
    const chunks: Candidate[] = [];
    for (const result of settled) {
      if (result.status === 'rejected') { graphState.error = String(result.reason); continue; }
      const hop = result.value;
      graphState.entities += hop.entities ?? 0; graphState.relations += hop.relations ?? 0;
      if (hop.reason !== 'ok') { graphState.error = hop.error ?? hop.reason; continue; }
      for (const chunk of hop.chunks) if (chunk.documentId && chunk.name && chunk.ordinal !== undefined) chunks.push({
        chunkId: chunk.chunkId, documentId: chunk.documentId, ordinal: chunk.ordinal, name: chunk.name,
        text: chunk.text, distance: chunk.priority + 1 / (1 + chunk.evidenceCount),
        documentKind: chunk.documentKind ?? 'SOURCE', ...(chunk.headingPath !== undefined ? { headingPath: chunk.headingPath } : {}),
        parentId: chunk.parentId ?? null, kind: chunk.kind ?? null, embedding: '',
      });
    }
    graphState.used = chunks.length > 0;
    return chunks.slice(0, 30);
  };
  const model = embeddingModel();
  const rewrite = process.env.RAG_REWRITE !== '0';
  const rerankEnabled = process.env.RAG_RERANK !== '0';
  // Keep the original query and leave most of the shared budget for retrieval.
  const queries = rewrite ? [...new Set([query, ...await rewriteQuery(query, Math.min(800, deadline - Date.now()))])] : [query];
  const embeddings = await beforeDeadline(embed(queries, AbortSignal.timeout(Math.max(0, deadline - Date.now())), model), deadline);
  if (embeddings.length !== queries.length) throw new Error('INVALID_EMBEDDING_COUNT');
  for (const embedding of embeddings) validateVector(embedding);
  const [vector] = embeddings;
  validateVector(vector);
  const kinds = allowedKinds(options);
  if (!kinds.length) return attach([]);
  const args = [JSON.stringify(vector), userId, conversationId, model, snapshot];
  const scoped = `${scope} AND d.kind IN (${kinds.map(kind => `'${kind}'`).join(',')})`;
  const graphWeight = Number.isFinite(options?.graphWeight) ? Math.max(0, options!.graphWeight!) : 0.35;
  const finish = async (hits: Hit[], candidates?: Candidate[]) => {
    const graph = await graphCandidates();
    const fused = graph.length && graphWeight > 0 && candidates
      ? reciprocalRankFusion([candidates, graph], [1, graphWeight]) : hits;
    const quota = options?.candidateQuota ?? [60, 25, 15];
    const selected = quotaCandidates(fused, kinds, 5, quota);
    return attach(await sourceEvidence(selected, userId, conversationId, snapshot, deadline));
  };
  const hybrid = process.env.RAG_HYBRID !== '0';
  const mmr = process.env.RAG_MMR !== '0';
  const small2big = process.env.RAG_SMALL2BIG !== '0';
  const pureVector = () => beforeDeadline(prisma.$queryRawUnsafe<Hit[]>(
    `SELECT ${projection} ${scoped}${retrievalKinds} ORDER BY distance,c.id LIMIT 5`, ...args), deadline);
  if (!hybrid && !mmr && !small2big && !rewrite && !rerankEnabled) {
    if (!graphEnabled) return finish(await pureVector());
    const rows = await beforeDeadline(prisma.$queryRawUnsafe<Candidate[]>(
      `SELECT ${projection},c.id AS "chunkId",c."parentId",c.kind,c.embedding::text AS embedding ${scoped}${retrievalKinds} ORDER BY distance,c.id LIMIT 20`, ...args), deadline);
    return finish(rows, rows);
  }

  let baseline: Hit[] | undefined;
  // Reserve time for a baseline retry if enhanced SQL fails. Timers bound caller waiting,
  // but Prisma raw queries cannot be cancelled by this Promise race.
  const enhancedDeadline = deadline - 200;
  try {
    const columns = `${projection},c.id AS "chunkId",c."parentId",c.kind,c.embedding::text AS embedding`;
    const vectorSearch = Promise.all(embeddings.map((embedding, index) => beforeDeadline(prisma.$queryRawUnsafe<Candidate[]>(
      `SELECT ${columns} ${scoped}${retrievalKinds} ORDER BY distance,c.id LIMIT 20`,
      JSON.stringify(embedding), userId, conversationId, model, snapshot), enhancedDeadline)
      .then(rows => { if (index === 0) baseline = rows.slice(0, 5); return rows; }))).then(mergeBestRank);
    const lexicalSearch = hybrid
      ? beforeDeadline(prisma.$queryRawUnsafe<Candidate[]>(
        `SELECT ${columns} ${scoped}${retrievalKinds}
         AND c.tsv @@ plainto_tsquery('pg_catalog.simple', $6)
         ORDER BY ts_rank(c.tsv, plainto_tsquery('pg_catalog.simple', $6)) DESC,c.id LIMIT 20`,
        ...args, query), enhancedDeadline)
      : Promise.resolve<Candidate[]>([]);
    // Wait for vector even if lexical fails, so its baseline remains available.
    const [vectors, lexical] = await Promise.allSettled([vectorSearch, lexicalSearch]);
    if (vectors.status === 'rejected') throw vectors.reason;
    if (lexical.status === 'rejected') throw lexical.reason;
    let ranked = (hybrid ? reciprocalRankFusion([vectors.value, lexical.value]) : vectors.value).slice(0, 20);
    if (mmr) {
      ranked = maximalMarginalRelevance(ranked.map(candidate => {
        const embedding: unknown = JSON.parse(candidate.embedding);
        validateVector(embedding);
        return { candidate, embedding };
      }), ranked.length).map(item => item.candidate);
    }
    const remaining = deadline - Date.now();
    if (rerankEnabled && remaining >= 1_000) ranked = await rerank(query, ranked, remaining - 200);
    if (!small2big) return finish(ranked.slice(0, 5), ranked);
    const parentIds = [...new Set(ranked.filter(hit => hit.kind === 'CHILD' && hit.parentId != null).map(hit => hit.parentId!))];
    const parents = parentIds.length ? await beforeDeadline(prisma.$queryRawUnsafe<(Hit & { chunkId: string })[]>(
      `SELECT ${projection},c.id AS "chunkId" ${scoped}
       AND c.kind='PARENT' AND c.id=ANY($6::text[])`, ...args, parentIds), enhancedDeadline) : [];
    const parentMap = new Map(parents.map(parent => [parent.chunkId, parent]));
    const seen = new Set<string>();
    const hits: Hit[] = [];
    for (const child of ranked) {
      const parent = child.kind === 'CHILD' && child.parentId ? parentMap.get(child.parentId) : undefined;
      const context = parent?.documentId === child.documentId ? parent : undefined;
      const key = context?.chunkId ?? child.chunkId;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ ...(context ?? child), distance: child.distance });
      if (hits.length === 5) break;
    }
    return finish(hits, hits as Candidate[]);
  } catch {
    // Enhancement failures skip both diversification and parent expansion.
    return finish(baseline ?? await pureVector());
  }
}
