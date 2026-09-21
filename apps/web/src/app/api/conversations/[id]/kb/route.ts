import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { prisma } from '@aichat/db';
import type { Prisma } from '@aichat/db';
import { auth } from '@/lib/auth';
import { KbError, kbError, ownedKb } from '@/lib/kb-api';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

async function lockConversation(tx: Prisma.TransactionClient, id: string, userId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Conversation" WHERE id = ${id} AND "ownerId" = ${userId} FOR UPDATE`;
  if (!rows.length) throw new KbError('NOT_FOUND', 404);
}

export async function GET(_req: Request, context: Context) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  try {
    const { id } = await context.params;
    return NextResponse.json(await prisma.$transaction(async tx => {
      await lockConversation(tx, id, session.user.id);
      const rows = await tx.$queryRaw<{ kbId: string }[]>`
        SELECT m."kbId" FROM "ConversationKnowledgeBase" m JOIN "KnowledgeBase" k ON k.id = m."kbId"
        WHERE m."conversationId" = ${id} AND k."userId" = ${session.user.id} ORDER BY m."kbId"`;
      return { kbIds: rows.map(row => row.kbId) };
    }));
  } catch (error) { return kbError(error); }
}

export async function PUT(req: Request, context: Context) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  try {
    let body: unknown;
    try { body = await req.json(); } catch { throw new KbError('INVALID_REQUEST', 400); }
    if (!body || typeof body !== 'object' || !('kbIds' in body) || !Array.isArray(body.kbIds) ||
        body.kbIds.some(id => typeof id !== 'string' || !id || id.length > 255)) throw new KbError('INVALID_REQUEST', 400);
    const kbIds = [...new Set(body.kbIds as string[])].sort();
    const { id } = await context.params;
    await prisma.$transaction(async tx => {
      await lockConversation(tx, id, session.user.id);
      // Lock in a stable order and validate every owner before changing any mount.
      for (const kbId of kbIds) await ownedKb(tx, kbId, session.user.id);
      await tx.$executeRaw`DELETE FROM "ConversationKnowledgeBase" WHERE "conversationId" = ${id}`;
      for (const kbId of kbIds) await tx.$executeRaw`
        INSERT INTO "ConversationKnowledgeBase" ("conversationId", "kbId") VALUES (${id}, ${kbId})`;
    });
    return NextResponse.json({ kbIds });
  } catch (error) { return kbError(error); }
}
