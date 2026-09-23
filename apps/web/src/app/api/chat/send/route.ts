import { CHAT_SSE } from '@/lib/config';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ModelResolutionError } from '@aichat/providers';
import { auth } from '@/lib/auth';
import { sendChat, sendChatStream, ChatNotFoundError } from '@/lib/chat-service';

export const maxDuration = 300;

const BodySchema = z.object({
  stream: z.boolean().optional(),
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
    const input = {
      userId: session.user.id,
      content: parsed.data.content,
      modelKey: parsed.data.modelKey,
      idempotencyKey: parsed.data.idempotencyKey,
      conversationId: parsed.data.conversationId ?? undefined,
    };
    if (parsed.data.stream || req.headers.get('accept')?.includes(CHAT_SSE.contentType)) {
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      req.signal.addEventListener('abort', onAbort, { once: true });
      if (req.signal.aborted) abort.abort();
      const iterator = sendChatStream(input, abort.signal);
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const heartbeat = setInterval(() => {
            if (!abort.signal.aborted) controller.enqueue(encoder.encode(': heartbeat\n\n'));
          }, CHAT_SSE.heartbeatIntervalMs);
          try {
            for await (const event of iterator) {
              if (abort.signal.aborted) break;
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            }
          } catch (error) {
            if (!abort.signal.aborted) controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              type: 'error', error: error instanceof Error ? error.message : 'internal error',
            })}\n\n`));
          } finally {
            clearInterval(heartbeat);
            req.signal.removeEventListener('abort', onAbort);
            try { controller.close(); } catch { /* Reader already cancelled. */ }
          }
        },
        async cancel() { abort.abort(); await iterator.return(undefined); },
      });
      return new Response(stream, { headers: {
        'content-type': CHAT_SSE.contentType,
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      } });
    }
    return NextResponse.json(await sendChat(input));
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
