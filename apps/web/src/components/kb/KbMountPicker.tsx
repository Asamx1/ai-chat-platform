'use client';

import { useCallback, useEffect, useState } from 'react';
import { kbStatus, type KnowledgeBase } from './types';

/**
 * 会话挂载选择器：列出本人 READY 的知识库，勾选后 PUT /api/conversations/[id]/kb。
 * 切换会话时 GET 同路径回显已挂载；未选中会话时禁用。
 */
export default function KbMountPicker({ conversationId }: { conversationId: string | null }) {
  const [open, setOpen] = useState(false);
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const disabled = !conversationId;

  // 拉取可用（READY）知识库
  const loadKbs = useCallback(async () => {
    try {
      const res = await fetch('/api/kb?limit=100', { credentials: 'include' });
      if (!res.ok) return;
      const data = (await res.json()) as { items?: KnowledgeBase[] };
      setKbs((data.items ?? []).filter((kb) => kbStatus(kb) === 'READY'));
    } catch {
      /* 面板打开时可重试 */
    } finally {
      setLoaded(true);
    }
  }, []);

  // 切换会话：回显已挂载
  useEffect(() => {
    setError(null);
    setSelected(new Set());
    if (!conversationId) return;
    let cancelled = false;
    fetch(`/api/conversations/${encodeURIComponent(conversationId)}/kb`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.kbIds) return;
        setSelected(new Set(data.kbIds as string[]));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const togglePanel = () => {
    const next = !open;
    setOpen(next);
    if (next) void loadKbs();
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async () => {
    if (!conversationId || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/kb`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kbIds: [...selected] }),
      });
      if (res.ok) {
        setOpen(false);
        return;
      }
      if (res.status === 404) setError('会话或知识库不存在');
      else setError('保存挂载失败，请稍后重试');
    } catch {
      setError('网络异常，保存请求未完成');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="kb-mount">
      <button
        type="button"
        className="kb-toggle-btn"
        disabled={disabled}
        title={disabled ? '需先选择一个会话' : undefined}
        onClick={togglePanel}
      >
        知识库{selected.size > 0 ? `(${selected.size})` : ''}
      </button>
      {open && !disabled && (
        <div className="kb-mount-panel">
          {loaded && kbs.length === 0 ? (
            <p className="kb-mount-empty">暂无就绪的知识库，请先到「知识库」页上传文档。</p>
          ) : (
            <ul className="kb-mount-list">
              {kbs.map((kb) => (
                <li key={kb.id}>
                  <label className="kb-mount-option">
                    <input type="checkbox" checked={selected.has(kb.id)} onChange={() => toggle(kb.id)} />
                    <span>{kb.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {error && <div className="msg-status failed">{error}</div>}
          <button type="button" className="btn-primary kb-save-btn" disabled={saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存挂载'}
          </button>
        </div>
      )}
    </div>
  );
}
