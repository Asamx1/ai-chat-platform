import type { SendChatResult } from './chat-service';

export type ChatStreamEvent =
  | ({ type: 'start' } & SendChatResult)
  | { type: 'delta'; text: string }
  | ({ type: 'done'; citations?: unknown } & SendChatResult)
  | { type: 'error'; error: string; cancelled?: boolean };

/** Decode UTF-8 and SSE frames across arbitrary network chunk boundaries. */
export async function* readChatStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n');
        if (data) yield JSON.parse(data) as ChatStreamEvent;
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
