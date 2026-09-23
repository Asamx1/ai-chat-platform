'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Conversation } from './types';

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 */
function relativeTime(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export default function ConversationList({
  activeId,
  onSelect,
  refreshKey,
}: {
  activeId: string | null;
  onSelect: (id: string) => void;
  /** 外部新建会话后 +1 触发重新拉取 */
  refreshKey: number;
}) {
  const [items, setItems] = useState<Conversation[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // GET /api/conversations → {items,total}
      const res = await fetch('/api/conversations', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: { items?: Conversation[] } = await res.json();
      setItems(data.items ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const createConversation = async () => {
    try {
      // POST /api/conversations {title,type}，成功后刷新列表并选中新会话
      const res = await fetch('/api/conversations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '新对话', type: 'SINGLE' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const conv: Conversation = await res.json();
      await load();
      onSelect(conv.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : '新建失败');
    }
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span>对话</span>
        <button className="btn btn-primary" onClick={() => void createConversation()}>
          + 新建
        </button>
      </div>
      <div className="conv-list">
        {error && <div className="msg-status failed">{error}</div>}
        {items.length === 0 && !error && (
          <div className="conv-time">暂无对话</div>
        )}
        {items.map((c) => (
          <div
            key={c.id}
            className={`conv-item${c.id === activeId ? ' active' : ''}`}
            onClick={() => onSelect(c.id)}
          >
            <div className="conv-title">{c.title || '未命名'}</div>
            <div className="conv-time">{relativeTime(c.updatedAt)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
