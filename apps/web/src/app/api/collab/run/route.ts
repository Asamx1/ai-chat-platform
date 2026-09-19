import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CollabCreateRunInputSchema, CollabSeatSchema } from '@aichat/contracts';
import { prisma } from '@aichat/db';
import { auth } from '@/lib/auth';

export const maxDuration = 300;

// 契约（M1/M2）只定义了核心字段；请求侧补充幂等键、可选首条消息与席数上限。
const BodySchema = CollabCreateRunInputSchema.extend({
  // 协作至少 2 席；辩论场景可到 8 席（4 正/反/裁判 + 备席）。
  seats: z.array(CollabSeatSchema).min(2).max(8),
  idempotencyKey: z.string().min(1),
  content: z.string().optional(),
});

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join('; ') },
      { status: 400 },
    );
  }
  const input = parsed.data;

  // 幂等重放：同 (ownerId, idempotencyKey) 直接返回已有 run。
  const existing = await prisma.orchestrationRun.findUnique({
    where: { ownerId_idempotencyKey: { ownerId: userId, idempotencyKey: input.idempotencyKey } },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json({ runId: existing.id });
  }

  // 所有权校验：非本人的 conversation 一律 404（不泄露存在性）。
  const conversation = await prisma.conversation.findFirst({
    where: { id: input.conversationId, ownerId: userId },
    select: { id: true },
  });
  if (!conversation) {
    return NextResponse.json({ error: 'conversation not found' }, { status: 404 });
  }

  // 先写 user Message（content 非空时），run 的 configSnapshot 引用其 id。
  let userMessageId: string | null = null;
  if (input.content && input.content.length > 0) {
    const msg = await prisma.message.create({
      data: {
        conversationId: input.conversationId,
        content: input.content,
        status: 'COMPLETE',
      },
    });
    userMessageId = msg.id;
  }

  try {
    const run = await prisma.orchestrationRun.create({
      data: {
        conversationId: input.conversationId,
        ownerId: userId,
        status: 'PENDING',
        idempotencyKey: input.idempotencyKey,
        configSnapshot: {
          mode: input.mode,
          seats: input.seats,
          content: input.content ?? '',
          userMessageId,
        },
        participantSnapshots: {
          create: input.seats.map((seat) => ({
            seatId: seat.seatId,
            providerKey: 'ollama',
            modelKey: seat.modelId,
            systemPrompt: seat.systemPrompt,
            params: { role: seat.role },
            pricingVersion: 'local-0',
          })),
        },
      },
    });
    return NextResponse.json({ runId: run.id });
  } catch (err) {
    // 并发同键创建：唯一约束冲突 → 返回已有 run。
    if ((err as { code?: string }).code === 'P2002') {
      const winner = await prisma.orchestrationRun.findUnique({
        where: { ownerId_idempotencyKey: { ownerId: userId, idempotencyKey: input.idempotencyKey } },
        select: { id: true },
      });
      if (winner) return NextResponse.json({ runId: winner.id });
    }
    const message = err instanceof Error ? err.message : 'internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
