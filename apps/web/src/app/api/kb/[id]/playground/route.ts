import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { prisma } from '@aichat/db';
import { embed, embeddingModel, validateVector, reciprocalRankFusion } from '@aichat/rag';
import { auth } from '@/lib/auth';
import { kbError, KbError } from '@/lib/kb-api';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

const SWITCHES = ['RAG_HYBRID', 'RAG_MMR', 'RAG_SMALL2BIG', 'RAG_RERANK', 'RAG_REWRITE'] as const;
const on = (name: string): boolean => process.env[name] !== '0';

type PreviewHit = {
  chunkId: string;
  documentId: string;
  name: string;
  chunkStrategy: string | null;
  kind: string | null;
  ordinal: number;
  text: string;
  distance: number;
};

/**
 * Preview retrieval without a conversation: the same SQL scope as retrieve() minus the
 * Conversation/ConversationKnowledgeBase joins — scoped directly by kbId + owner.
 * Simplification: query rewrite, MMR, LLM rerank and small-to-big parent expansion are NOT
 * applied here; hybrid RRF is (it changes ranking).
 */
async function retrieveForPreview(kbId: string, userId: string, query: string): Promise<PreviewHit[]> {
  const model = embeddingModel();
  const [vector] = await embed([query], AbortSignal.timeout(2_500), model);
  validateVector(vector);
  const scope = `FROM "Chunk" c JOIN "Document" d ON d.id=c."documentId"
    JOIN "KnowledgeBase" k ON k.id=d."kbId"
    WHERE k.id=$2 AND k."userId"=$3 AND d.status='READY' AND d.model=$4
      AND (c.kind IS NULL OR c.kind IN ('CHILD','STANDALONE'))`;
  const columns = `c.id AS "chunkId",c."documentId",d.name,d."chunkStrategy",c.kind,c.ordinal,c.text,
    c.embedding <=> $1::vector(1024) AS distance`;
  const vectorHits = await prisma.$queryRawUnsafe<PreviewHit[]>(
    `SELECT ${columns} ${scope} ORDER BY distance,c.id LIMIT 20`,
    JSON.stringify(vector), kbId, userId, model);
  let ranked = vectorHits;
  if (on('RAG_HYBRID')) {
    const lexical = await prisma.$queryRawUnsafe<PreviewHit[]>(
      `SELECT ${columns} ${scope}
       AND c.tsv @@ plainto_tsquery('pg_catalog.simple', $5)
       ORDER BY ts_rank(c.tsv, plainto_tsquery('pg_catalog.simple', $5)) DESC,c.id LIMIT 20`,
      JSON.stringify(vector), kbId, userId, model, query);
    ranked = reciprocalRankFusion([vectorHits, lexical]);
  }
  // Parent expansion (RAG_SMALL2BIG) is intentionally NOT applied: preview shows the matched
  // chunk itself so the kind/ordinal shown alongside each hit stays honest.
  return ranked.slice(0, 5);
}

export async function GET(_req: Request, context: Context) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  try {
    const { id } = await context.params;
    const rows = await prisma.$queryRaw<{ id: string; name: string }[]>`
      SELECT id, name FROM "KnowledgeBase" WHERE id = ${id} AND "userId" = ${session.user.id}`;
    if (!rows[0]) throw new KbError('NOT_FOUND', 404);
    const strategies = await prisma.$queryRaw<{ chunkStrategy: string }[]>`
      SELECT DISTINCT "chunkStrategy" FROM "Document" WHERE "kbId" = ${id} ORDER BY "chunkStrategy"`;
    return NextResponse.json({
      id: rows[0].id,
      name: rows[0].name,
      strategies: strategies.map(row => row.chunkStrategy),
      switches: Object.fromEntries(SWITCHES.map(name => [name, on(name)])),
    });
  } catch (error) { return kbError(error); }
}

export async function POST(req: Request, context: Context) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  try {
    const { id } = await context.params;
    let body: unknown;
    try { body = await req.json(); } catch { throw new KbError('INVALID_REQUEST', 400); }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new KbError('INVALID_REQUEST', 400);
    const { query } = body as { query?: unknown };
    if (typeof query !== 'string' || !query.trim() || query.length > 2_000) throw new KbError('INVALID_REQUEST', 400);
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "KnowledgeBase" WHERE id = ${id} AND "userId" = ${session.user.id}`;
    if (!rows[0]) throw new KbError('NOT_FOUND', 404);
    const hits = await retrieveForPreview(id, session.user.id, query.trim());
    return NextResponse.json({ hits });
  } catch (error) { return kbError(error); }
}
