import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ send: vi.fn(), stream: vi.fn() }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: async () => ({ user: { id: 'user' } }) } } }));
vi.mock('@/lib/chat-service', () => ({
  sendChat: mocks.send, sendChatStream: mocks.stream, ChatNotFoundError: class extends Error {},
}));
import { POST } from '../src/app/api/chat/send/route';
import { readChatStream } from '../src/lib/chat-stream';

const result = { conversationId: 'conv', messageId: 'message', runId: 'run' };
function request(stream = true, signal?: AbortSignal, bodyStream = false) {
  return new Request('http://localhost/api/chat/send', {
    method: 'POST', headers: { Accept: stream ? 'text/event-stream' : 'application/json' },
    ...(signal ? { signal } : {}),
    body: JSON.stringify({ content: 'hi', modelKey: 'fake', idempotencyKey: 'same-key', stream: bodyStream }),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.send.mockResolvedValue(result);
  mocks.stream.mockImplementation(async function* () {
    yield { type: 'start', ...result };
    yield { type: 'delta', text: '你' };
    yield { type: 'delta', text: '好' };
    yield { type: 'done', ...result };
  });
});
it.each([false, true])('streams ordered deltas and done, body opt-in=%s', async bodyStream => {
  const response = await POST(request(!bodyStream, undefined, bodyStream));
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const events = [];
  for await (const event of readChatStream(response.body!)) events.push(event);
  expect(events.filter(e => e.type === 'delta').map(e => e.text).join('')).toBe('你好');
  expect(events.at(-1)).toEqual({ type: 'done', ...result });
  expect(mocks.send).not.toHaveBeenCalled();
});
it('encodes generator failures as error events', async () => {
  mocks.stream.mockImplementation(async function* () { throw new Error('provider failed'); });
  expect(await (await POST(request())).text()).toContain('"error":"provider failed"');
});
it('cancels upstream when the response reader disconnects', async () => {
  let cancelled = false;
  mocks.stream.mockImplementation(async function* (_input, signal: AbortSignal) {
    try {
      yield { type: 'start', ...result };
      await new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve(), { once: true });
        if (signal.aborted) resolve();
      });
    } finally { cancelled = signal.aborted; }
  });
  const response = await POST(request());
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  expect(cancelled).toBe(true);
});
it('keeps JSON send compatible and forwards the same idempotency key', async () => {
  const response = await POST(request(false));
  expect(await response.json()).toEqual(result);
  expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'same-key' }));
  expect(mocks.stream).not.toHaveBeenCalled();
});
it('decodes split UTF-8 bytes and CRLF frames', async () => {
  const bytes = new TextEncoder().encode('data: {"type":"delta","text":"你好"}\r\n\r\n');
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  const events = [];
  for await (const event of readChatStream(body)) events.push(event);
  expect(events).toEqual([{ type: 'delta', text: '你好' }]);
});
