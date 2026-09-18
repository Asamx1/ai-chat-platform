import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@aichat/db';
import { createConversation, listConversationsByOwner } from '@aichat/db';

export async function GET(req: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);

  const page = await listConversationsByOwner(prisma, session.user.id, { limit, offset });
  return NextResponse.json({
    items: page.items.map((c) => ({
      id: c.id,
      title: c.title,
      type: c.type,
      updatedAt: c.updatedAt,
    })),
    total: page.total,
  });
}

const CreateBodySchema = z.object({
  title: z.string().min(1),
  type: z.enum(['SINGLE', 'GROUP', 'CONSENSUS', 'DEBATE']),
});

export async function POST(req: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const parsed = CreateBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join('; ') },
      { status: 400 },
    );
  }

  const conversation = await createConversation(
    prisma,
    session.user.id,
    parsed.data.title,
    parsed.data.type,
  );
  return NextResponse.json({ id: conversation.id });
}
