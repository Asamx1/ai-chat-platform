'use client';

import React, { useEffect, useRef } from 'react';
import type { ChatMessage } from './types';
import CitationBadges from './CitationBadges';
import Markdown from './Markdown';

const STATUS_LABEL: Record<string, string> = {
  streaming: '生成中…',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已停止',
  error: '出错',
};

export default function MessageStream({
  messages,
  onRetry,
}: {
  messages: ChatMessage[];
  onRetry?: (idempotencyKey: string) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages]);

  if (messages.length === 0) {
    return <div className="empty-state">开始新的对话吧</div>;
  }

  return (
    <div className="messages">
      {messages.map((m) => (
        <div key={m.id} className={`msg-row ${m.role}`}>
          <div>
            <div className="msg-bubble">
              {(m.content ? (m.role === 'assistant' ? <Markdown text={m.content} /> : m.content) : '') || (m.status === 'streaming' ? <span className="thinking" role="status" aria-label="正在思考"><span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /></span> : '')}
              {m.role === 'assistant' && <CitationBadges citations={m.citations ?? []} />}
            </div>
            {m.status && (
              <div className={`msg-status${m.status === 'failed' || m.status === 'error' ? ' failed' : ''}`}>
                {STATUS_LABEL[m.status] ?? m.status}
                {m.error && <span role="alert">：{m.error}</span>}
                {onRetry && (m.status === 'failed' || m.status === 'error') && m.retryIdempotencyKey && (
                  <button
                    className="btn retry-btn"
                    onClick={() => onRetry(m.retryIdempotencyKey as string)}
                  >
                    重试
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
