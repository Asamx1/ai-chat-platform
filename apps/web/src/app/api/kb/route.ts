import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { prisma } from '@aichat/db';
import { auth } from '@/lib/auth';
import { documents, KbError, kbError, ownedKb, publicDocument, readUpload, validateFile } from '@/lib/kb-api';
import type { DocumentRow, KbRow } from '@/lib/kb-api';
import { put, remove } from '@/lib/minio';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  try {
    const params = new URL(req.url).searchParams;
    const offset = params.get('offset') ?? '0';
    const limit = params.get('limit') ?? '20';
    if (!/^\d+$/.test(offset) || !/^\d+$/.test(limit) || !Number.isSafeInteger(Number(offset)) || Number(limit) < 1 || Number(limit) > 100) {
      throw new KbError('INVALID_REQUEST', 400);
    }
    const result = await prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<KbRow[]>`
        SELECT id, name FROM "KnowledgeBase" WHERE "userId" = ${session.user.id}
        ORDER BY "updatedAt" DESC, id OFFSET ${Number(offset)} LIMIT ${Number(limit)}`;
      const counts = await tx.$queryRaw<{ total: bigint }[]>`SELECT count(*) AS total FROM "KnowledgeBase" WHERE "userId" = ${session.user.id}`;
      return { items: await Promise.all(rows.map(async row => ({ ...row, documents: await documents(tx, row.id) }))), total: Number(counts[0]?.total ?? 0) };
    }, { isolationLevel: 'RepeatableRead' });
    return NextResponse.json(result);
  } catch (error) { return kbError(error); }
}

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  let objectKey: string | undefined;
  try {
    const form = await readUpload(req);
    const file = form.get('file');
    const name = form.get('name');
    const existingId = form.get('kbId');
    if (!(file instanceof File) || form.getAll('file').length !== 1 ||
        form.getAll('name').length > 1 || form.getAll('kbId').length > 1 ||
        [...form.keys()].some(key => !['file', 'name', 'kbId'].includes(key)) ||
        (name === null) === (existingId === null) ||
        (name !== null && (typeof name !== 'string' || !name.trim() || name.length > 255)) ||
        (existingId !== null && (typeof existingId !== 'string' || !existingId || existingId.length > 255))) {
      throw new KbError('INVALID_REQUEST', 400);
    }
    const kbId = typeof existingId === 'string' ? existingId : randomUUID();
    if (existingId !== null) await prisma.$transaction(tx => ownedKb(tx, kbId, session.user.id));
    const data = await validateFile(file);
    const documentId = randomUUID();
    objectKey = `${session.user.id}/${kbId}/${documentId}`;
    await put(objectKey, data, file.type);
    const key = objectKey;
    const document = await prisma.$transaction(async tx => {
      if (typeof name === 'string') {
        await tx.$executeRaw`INSERT INTO "KnowledgeBase" (id, "userId", name, "createdAt", "updatedAt")
          VALUES (${kbId}, ${session.user.id}, ${name.trim()}, NOW(), NOW())`;
      } else await ownedKb(tx, kbId, session.user.id);
      const rows = await tx.$queryRaw<DocumentRow[]>`
        INSERT INTO "Document" (id, "kbId", name, mime, "objectKey", model, size, status, "chunkCount", attempt, "createdAt", "updatedAt")
        VALUES (${documentId}, ${kbId}, ${file.name}, ${file.type}, ${key}, ${process.env.EMBEDDING_MODEL || 'bge-m3:latest'},
          ${data.byteLength}, 'PENDING', 0, 0, NOW(), NOW())
        RETURNING id, name, status, "chunkCount", "createdAt", error`;
      await tx.$executeRaw`UPDATE "KnowledgeBase" SET "updatedAt" = NOW() WHERE id = ${kbId} AND "userId" = ${session.user.id}`;
      if (!rows[0]) throw new KbError('KB_UNAVAILABLE', 503);
      return publicDocument(rows[0]);
    });
    objectKey = undefined;
    return NextResponse.json({ kbId, document }, { status: 202 });
  } catch (error) {
    if (objectKey) await remove(objectKey).catch(() => {}); // Failed compensation is retried by orphan GC.
    return kbError(error);
  }
}
