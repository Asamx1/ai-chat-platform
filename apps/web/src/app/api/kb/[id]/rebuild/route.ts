import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { prisma } from '@aichat/db';
import { auth } from '@/lib/auth';
import { kbError, KbError, ownedKb } from '@/lib/kb-api';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
type Mode = 'rechunk' | 'recompile' | 'rebuild';
type Source = { id: string; sourceVersionId: string };

async function owner(context: Context) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) throw new KbError('UNAUTHORIZED', 401);
  return { id: (await context.params).id, userId: session.user.id };
}

export async function POST(req: Request, context: Context) {
  try {
    const { id, userId } = await owner(context);
    let body: unknown;
    try { body = await req.json(); } catch { throw new KbError('INVALID_REQUEST', 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new KbError('INVALID_REQUEST', 400);
    const action = (body as { action?: unknown }).action;
    if (action === 'cancel') {
      const result = await prisma.$transaction(async tx => {
        await ownedKb(tx, id, userId);
        const current = await tx.indexGeneration.findFirst({ where: { kbId: id, status: 'BUILDING' }, orderBy: { createdAt: 'desc' } });
        if (!current) return null;
        await tx.indexGeneration.update({ where: { id: current.id }, data: { status: 'FAILED' } });
        await tx.compileJob.updateMany({ where: { generationId: current.id, status: { in: ['PENDING', 'RUNNING'] } },
          data: { status: 'CANCELLED', leaseOwner: null, leaseExpiresAt: null } });
        await tx.compileOutbox.updateMany({ where: { generationId: current.id, processedAt: null }, data: { processedAt: new Date() } });
        return current.id;
      });
      return NextResponse.json({ jobId: result, cancelled: result !== null });
    }
    const mode = (body as { mode?: unknown }).mode;
    if (mode !== 'rechunk' && mode !== 'recompile' && mode !== 'rebuild') throw new KbError('INVALID_REQUEST', 400);
    const requestedStrategy = (body as { strategy?: unknown }).strategy;
    if (requestedStrategy !== undefined && requestedStrategy !== 'structure' && requestedStrategy !== 'semantic') throw new KbError('INVALID_REQUEST', 400);
    const result = await prisma.$transaction(async tx => {
      const kb = await ownedKb(tx, id, userId);
      const building = await tx.indexGeneration.findFirst({ where: { kbId: id, status: 'BUILDING' }, orderBy: { createdAt: 'desc' } });
      if (building) return { jobId: building.id, accepted: false };
      const sources = await tx.$queryRaw<Source[]>`
        SELECT id,"sourceVersionId" FROM "Document" WHERE "kbId"=${id} AND kind='SOURCE' AND status='READY'
          AND "sourceVersionId" IS NOT NULL ORDER BY id`;
      if (!sources.length) throw new KbError('NO_READY_SOURCES', 409);
      if (mode === 'recompile' && !kb) throw new KbError('NOT_FOUND', 404);
      const generation = await tx.indexGeneration.create({ data: { kbId: id, status: 'BUILDING',
        configSnapshot: { mode, strategy: requestedStrategy ?? 'structure', sources, targetDocumentCount: sources.length, sourceGenerationId:
          (await tx.knowledgeBase.findUniqueOrThrow({ where: { id } })).activeGenerationId } } });
      if (mode === 'recompile') {
        const active = await tx.knowledgeBase.findUniqueOrThrow({ where: { id } });
        if (!active.activeGenerationId) throw new KbError('NO_ACTIVE_GENERATION', 409);
        // Clone parent rows first, then children with stable new IDs. The old generation keeps serving.
        for (const kind of ['PARENT', 'CHILD'] as const) await tx.$executeRawUnsafe(`
          INSERT INTO "Chunk" (id,"kbId","generationId","documentId","parentId",kind,ordinal,start,"end",text,"headingPath",embedding)
          SELECT md5($1 || ':' || c.id),c."kbId",$1,c."documentId",
            CASE WHEN c."parentId" IS NULL THEN NULL ELSE md5($1 || ':' || c."parentId") END,
            c.kind,c.ordinal,c.start,c."end",c.text,c."headingPath",c.embedding
          FROM "Chunk" c JOIN "Document" d ON d.id=c."documentId"
          WHERE c."generationId"=$2 AND c."kbId"=$3 AND d.kind='SOURCE' AND d.status='READY'
            AND c.kind ${kind === 'PARENT' ? "= 'PARENT'" : "<> 'PARENT'"}
            AND EXISTS (SELECT 1 FROM "SourceVersion" s WHERE s.id=d."sourceVersionId" AND s."documentId"=d.id)`,
          generation.id, active.activeGenerationId, id);
        await tx.$executeRawUnsafe(`UPDATE "IndexGeneration" g SET "documentCount"=(SELECT count(DISTINCT "documentId") FROM "Chunk" WHERE "generationId"=g.id),
          "chunkCount"=(SELECT count(*) FROM "Chunk" WHERE "generationId"=g.id) WHERE g.id=$1`, generation.id);
        for (const source of sources) await tx.compileOutbox.create({ data: { id: randomUUID(), kbId: id,
          documentId: source.id, sourceVersionId: source.sourceVersionId, generationId: generation.id, eventType: 'SOURCE_READY' } });
      } else {
        for (const source of sources) await tx.compileJob.create({ data: { kbId: id, sourceVersionId: source.sourceVersionId,
          generationId: generation.id, artifactType: 'RECHUNK', model: 'bge-m3', promptVersion: `${mode}:${requestedStrategy ?? 'structure'}`,
          schemaVersion: 'v1', idempotencyKey: `rechunk:${generation.id}:${source.id}` } });
      }
      return { jobId: generation.id, accepted: true };
    });
    return NextResponse.json(result, { status: 202 });
  } catch (error) { return kbError(error); }
}

export async function GET(_req: Request, context: Context) {
  try {
    const { id, userId } = await owner(context);
    return NextResponse.json(await prisma.$transaction(async tx => {
      await ownedKb(tx, id, userId);
      const generation = await tx.indexGeneration.findFirst({ where: { kbId: id }, orderBy: { createdAt: 'desc' } });
      if (!generation) throw new KbError('NOT_FOUND', 404);
      const snapshot = generation.configSnapshot as { targetDocumentCount?: number; sources?: Source[]; mode?: Mode };
      const [actual] = await tx.$queryRaw<{ documentCount: number; chunkCount: number }[]>`
        SELECT count(DISTINCT "documentId")::int AS "documentCount", count(*)::int AS "chunkCount"
        FROM "Chunk" WHERE "generationId"=${generation.id} AND "kbId"=${id} AND "documentId" IN
          (SELECT id FROM "Document" WHERE "kbId"=${id} AND kind='SOURCE')`;
      const jobs = await tx.compileJob.groupBy({ by: ['status'], where: { generationId: generation.id }, _count: { _all: true } });
      return { jobId: generation.id, mode: snapshot.mode, status: generation.status,
        progress: { documentCount: actual?.documentCount ?? 0, chunkCount: actual?.chunkCount ?? 0,
          targetDocumentCount: snapshot.targetDocumentCount ?? snapshot.sources?.length ?? 0 },
        compileJobs: Object.fromEntries(jobs.map(row => [row.status, row._count._all])) };
    }));
  } catch (error) { return kbError(error); }
}
