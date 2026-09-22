import { prisma } from '@aichat/db';
import { embed, embeddingModel, validateVector } from './embed';
import { rerank } from './rerank';
import { rewriteQuery } from './rewrite';
export type Hit = { documentId: string; ordinal: number; name: string; text: string; distance: number; headingPath?: string | null };
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
export function reciprocalRankFusion<T extends { chunkId: string; distance: number }>(lists: readonly (readonly T[])[]): T[] {
  const fused = new Map<string, { item: T; score: number }>();
  for (const list of lists) {
    const seen = new Set<string>();
    let rank = 0;
    for (const item of list) {
      if (seen.has(item.chunkId)) continue;
      seen.add(item.chunkId);
      rank += 1;
      const entry = fused.get(item.chunkId) ?? { item, score: 0 };
      entry.score += 1 / (60 + rank);
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
     WHERE k."userId"=$2 AND v."ownerId"=$2 AND v.id=$3 AND d.status='READY' AND d.model=$4`;
const projection = `c."documentId",c.ordinal,d.name,c.text,c."headingPath",c.embedding <=> $1::vector(1024) AS distance`;
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

export async function retrieve(userId: string, conversationId: string, query: string): Promise<Hit[]> {
  const deadline = Date.now() + 3_000;
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
  const args = [JSON.stringify(vector), userId, conversationId, model];
  const hybrid = process.env.RAG_HYBRID !== '0';
  const mmr = process.env.RAG_MMR !== '0';
  const small2big = process.env.RAG_SMALL2BIG !== '0';
  const pureVector = () => beforeDeadline(prisma.$queryRawUnsafe<Hit[]>(
    `SELECT ${projection} ${scope}${retrievalKinds} ORDER BY distance,c.id LIMIT 5`, ...args), deadline);
  if (!hybrid && !mmr && !small2big && !rewrite && !rerankEnabled) return pureVector();

  let baseline: Hit[] | undefined;
  // Reserve time for a baseline retry if enhanced SQL fails. Timers bound caller waiting,
  // but Prisma raw queries cannot be cancelled by this Promise race.
  const enhancedDeadline = deadline - 200;
  try {
    const columns = `${projection},c.id AS "chunkId",c."parentId",c.kind,c.embedding::text AS embedding`;
    const vectorSearch = Promise.all(embeddings.map((embedding, index) => beforeDeadline(prisma.$queryRawUnsafe<Candidate[]>(
      `SELECT ${columns} ${scope}${retrievalKinds} ORDER BY distance,c.id LIMIT 20`,
      JSON.stringify(embedding), userId, conversationId, model), enhancedDeadline)
      .then(rows => { if (index === 0) baseline = rows.slice(0, 5).map(hitOnly); return rows; }))).then(mergeBestRank);
    const lexicalSearch = hybrid
      ? beforeDeadline(prisma.$queryRawUnsafe<Candidate[]>(
        `SELECT ${columns} ${scope}${retrievalKinds}
         AND c.tsv @@ plainto_tsquery('pg_catalog.simple', $5)
         ORDER BY ts_rank(c.tsv, plainto_tsquery('pg_catalog.simple', $5)) DESC,c.id LIMIT 20`,
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
    if (!small2big) return ranked.slice(0, 5).map(hitOnly);
    const parentIds = [...new Set(ranked.filter(hit => hit.kind === 'CHILD' && hit.parentId != null).map(hit => hit.parentId!))];
    const parents = parentIds.length ? await beforeDeadline(prisma.$queryRawUnsafe<(Hit & { chunkId: string })[]>(
      `SELECT ${projection},c.id AS "chunkId" ${scope}
       AND c.kind='PARENT' AND c.id=ANY($5::text[])`, ...args, parentIds), enhancedDeadline) : [];
    const parentMap = new Map(parents.map(parent => [parent.chunkId, parent]));
    const seen = new Set<string>();
    const hits: Hit[] = [];
    for (const child of ranked) {
      const parent = child.kind === 'CHILD' && child.parentId ? parentMap.get(child.parentId) : undefined;
      const context = parent?.documentId === child.documentId ? parent : undefined;
      const key = context?.chunkId ?? child.chunkId;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(hitOnly({ ...(context ?? child), distance: child.distance }));
      if (hits.length === 5) break;
    }
    return hits;
  } catch {
    // Enhancement failures skip both diversification and parent expansion.
    return baseline ?? pureVector();
  }
}
