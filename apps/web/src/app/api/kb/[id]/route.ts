import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { prisma } from '@aichat/db';
import { auth } from '@/lib/auth';
import { documents, kbError, ownedKb } from '@/lib/kb-api';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export async function GET(_req: Request, context: Context) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  try {
    const { id } = await context.params;
    return NextResponse.json(await prisma.$transaction(async tx => {
      const kb = await ownedKb(tx, id, session.user.id);
      return { ...kb, documents: await documents(tx, id) };
    }));
  } catch (error) { return kbError(error); }
}

export async function DELETE(_req: Request, context: Context) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  try {
    const { id } = await context.params;
    await prisma.$transaction(async tx => {
      await ownedKb(tx, id, session.user.id);
      // §1 FK cascades remove documents, chunks and mounts; orphan GC retries object deletion.
      await tx.$executeRaw`DELETE FROM "KnowledgeBase" WHERE id = ${id} AND "userId" = ${session.user.id}`;
    });
    return new NextResponse(null, { status: 204 });
  } catch (error) { return kbError(error); }
}
