import { expect, it } from 'vitest';
import { injectContext } from '../src/inject';
import type { ChatMessage } from '@aichat/providers';

const hits = [
  { documentId: 'doc-a', ordinal: 0, name: 'A', text: '甲'.repeat(220), distance: 0.1 },
  { documentId: 'doc-b', ordinal: 3, name: 'B', text: '第二条证据', distance: 0.2 },
];
const messages: ChatMessage[] = [
  { role: 'system', content: '原有系统提示' },
  { role: 'user', content: '历史问题' },
  { role: 'assistant', content: '历史回答' },
  { role: 'user', content: '原始议题' },
];
const capabilities = { maxContext: 8192, maxOutput: 2048 };

it('wraps evidence as user data with matching nonce, preserves systems/history and keeps question last', () => {
  const result = injectContext(messages, hits, capabilities);
  expect(result.messages[0]).toEqual(messages[0]);
  expect(result.messages[1]).toMatchObject({ role: 'system' });
  expect(result.messages.slice(2, 4)).toEqual(messages.slice(1, 3));
  expect(result.messages.at(-1)).toEqual(messages.at(-1));
  const block = result.messages.at(-2)!;
  expect(block.role).toBe('user');
  const match = /^RAG_DATA_([^\n]+)\n([\s\S]+)\nEND_RAG_DATA_\1$/.exec(block.content);
  expect(match).not.toBeNull();
  expect(JSON.parse(match![2]!)).toEqual(hits);
  expect(result.citations).toEqual([
    expect.objectContaining({ documentId: 'doc-a', ordinal: 0, text: `${'甲'.repeat(200)}…` }),
    expect.objectContaining({ documentId: 'doc-b', ordinal: 3, text: '第二条证据' }),
  ]);
  expect(messages).toHaveLength(4);
  expect(hits).toHaveLength(2);
});

it('drops the least relevant evidence one at a time when the context budget only fits one', () => {
  const one = injectContext(messages, hits.slice(0, 1), capabilities);
  const bytes = one.messages.reduce((n, m) => n + Buffer.byteLength(m.content, 'utf8') + 32, 0);
  const result = injectContext(messages, [...hits].reverse(), {
    maxContext: bytes + capabilities.maxOutput + 256, maxOutput: capabilities.maxOutput,
  });
  expect(result.citations).toEqual(one.citations);
  expect(result.messages.at(-2)!.content).toContain('doc-a');
  expect(result.messages.at(-2)!.content).not.toContain('doc-b');
  expect(result.messages.at(-1)).toEqual(messages.at(-1));
});

it('omits all evidence when only the original messages fit', () => {
  const bytes = messages.reduce((n, m) => n + Buffer.byteLength(m.content, 'utf8') + 32, 0);
  const result = injectContext(messages, hits, { maxContext: bytes + 2048 + 256, maxOutput: 2048 });
  expect(result.messages).toEqual(messages);
  expect(result.citations).toEqual([]);
});
