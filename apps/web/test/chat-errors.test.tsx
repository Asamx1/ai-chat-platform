import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { applyRunEvent, sendFailure } from '../src/components/chat/chat-events';
import MessageStream from '../src/components/chat/MessageStream';
import type { ChatMessage } from '../src/components/chat/types';

const message: ChatMessage = { id: 'assistant', role: 'assistant', content: '', status: 'streaming' };

describe('chat error visibility and SSE envelope', () => {
  it.each([400, 503])('reads the failure reason from HTTP %s', async status => {
    expect(await sendFailure(Response.json({ error: '所选模型暂不可用' }, { status })))
      .toBe('所选模型暂不可用');
  });
  it('provides a readable fallback for non-JSON HTTP errors', async () => {
    expect(await sendFailure(new Response('bad gateway', { status: 502 }))).toContain('HTTP 502');
  });
  it('accumulates deltas from the server payload and completes the message', () => {
    const next = applyRunEvent(message, { type: 'provider.delta', payload: { delta: 'hello' } }, 'retry');
    expect(next.content).toBe('hello');
    expect(applyRunEvent(next, { type: 'run.succeeded' }, 'retry').status).toBe('succeeded');
  });
  it.each(['模型解析失败', { message: '模型解析失败' }])('renders failure reasons while preserving partial output', error => {
    const next = applyRunEvent({ ...message, content: 'partial' }, { type: 'run.failed', payload: { error } }, 'retry');
    expect(next).toMatchObject({ content: 'partial', status: 'failed', retryIdempotencyKey: 'retry' });
    const markup = renderToStaticMarkup(<MessageStream messages={[next]} onRetry={() => {}} />);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('模型解析失败');
    expect(markup).toContain('partial');
    expect(markup).toContain('重试');
  });
  it('supports legacy flattened events and a missing error reason', () => {
    expect(applyRunEvent(message, { type: 'provider.delta', delta: 'old' }, 'r').content).toBe('old');
    expect(applyRunEvent(message, { type: 'error' }, 'r').error).toBe('生成失败，请稍后重试。');
  });
});
