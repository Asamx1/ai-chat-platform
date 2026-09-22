import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { prisma } from '@aichat/db';
import { getStrategy } from '@aichat/rag';
import { auth } from '@/lib/auth';
import { kbError, KbError } from '@/lib/kb-api';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

/**
 * Re-chunk a document: [id] is the document id. The strategy is validated against the
 * chunk-strategy registry BEFORE any mutation so an invalid request leaves chunks and
 * document state untouched. Reset is transactional and idempotent — repeating the same
 * request converges to the same PENDING document with the old chunks already deleted.
 */
export async function POST(req: Request, context: Context) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  try {
    const { id } = await context.params;
    let body: unknown;
    try { body = await req.json(); } catch { throw new KbError('INVALID_REQUEST', 400); }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new KbError('INVALID_REQUEST', 400);
    const { strategy, size } = body as { strategy?: unknown; size?: unknown };
    if (typeof strategy !== 'string') throw new KbError('INVALID_REQUEST', 400);
    // Registry membership check only; an unknown strategy is a 400 and clears nothing.
    type StrategyKey = Parameters<typeof getStrategy>[0];
    try { getStrategy(strategy as StrategyKey); } catch { throw new KbError('INVALID_REQUEST', 400); }
    const sizeNum: unknown = size;
    if (sizeNum !== undefined &&
        (typeof sizeNum !== 'number' || !Number.isSafeInteger(sizeNum) || sizeNum < 64 || sizeNum > 4096)) throw new KbError('INVALID_REQUEST', 400);
    const updated = await prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT d.id FROM "Document" d
        JOIN "KnowledgeBase" k ON k.id = d."kbId"
        WHERE d.id = ${id} AND k."userId" = ${session.user.id}
        FOR UPDATE OF d`;
      if (!rows[0]) throw new KbError('NOT_FOUND', 404);
      // The existing ingest queue re-embeds from object storage; chunks are regenerated wholesale.
      await tx.$executeRaw`DELETE FROM "Chunk" WHERE "documentId" = ${id}`;
      const count = await tx.$executeRaw`
        UPDATE "Document" SET status='PENDING', attempt=0, error=NULL,
          "leaseOwner"=NULL, "leaseExpiresAt"=NULL, "chunkCount"=0,
          "chunkStrategy"=${strategy}, "updatedAt"=NOW()
        WHERE id = ${id}`;
      if (count !== 1) throw new KbError('KB_UNAVAILABLE', 503);
      return rows[0];
    });
    return NextResponse.json({ id: updated.id, status: 'PENDING', chunkStrategy: strategy }, { status: 202 });
  } catch (error) { return kbError(error); }
}
