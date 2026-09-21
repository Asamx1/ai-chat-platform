import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ModelResolutionError } from '@aichat/providers';
import { auth } from '@/lib/auth';
import { sendChat, ChatNotFoundError } from '@/lib/chat-service';

export const maxDuration = 300;

const BodySchema = z.object({
  conversationId: z.string().min(1).optional(),
  content: z.string().min(1),
  modelKey: z.string().min(1),
  idempotencyKey: z.string().min(1),
});

export async function POST(req: Request) {
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

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join('; ') },
      { status: 400 },
    );
  }

  try {
    const result = await sendChat({
      userId: session.user.id,
      content: parsed.data.content,
      modelKey: parsed.data.modelKey,
      idempotencyKey: parsed.data.idempotencyKey,
      conversationId: parsed.data.conversationId ?? undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ModelResolutionError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    if (err instanceof ChatNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    const message = err instanceof Error ? err.message : 'internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
