import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@aichat/db';

/** GET /api/conversations/[id]/messages?limit=50&before=<iso>
 * 历史消息分页（createdAt 游标倒序返回正序数组）。所有权校验：非本人 404。 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const conv = await prisma.conversation.findFirst({
    where: { id, ownerId: session.user.id },
    select: { id: true },
  });
  if (!conv) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
  const before = url.searchParams.get('before');

  const messages = await prisma.message.findMany({
    where: { conversationId: id, ...(before ? { createdAt: { lt: new Date(before) } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      content: true,
      status: true,
      participantId: true,
      createdAt: true,
    },
  });
  // participantId 非空 = assistant 席位消息；M1 单聊：participant 为空 = user 消息
  const items = messages
    .slice()
    .reverse()
    .map((m) => ({
      id: m.id,
      role: m.participantId ? ('assistant' as const) : ('user' as const),
      content: m.content,
      status: m.status,
      createdAt: m.createdAt.toISOString(),
    }));
  const nextBefore = messages.length === limit ? messages[messages.length - 1]?.createdAt.toISOString() : null;
  return NextResponse.json({ items, nextBefore });
}
