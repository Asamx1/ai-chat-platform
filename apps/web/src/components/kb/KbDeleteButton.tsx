'use client';

import { useState } from 'react';

/** 删除按钮：二次确认后 DELETE /api/kb/[id] → 204 */
export default function KbDeleteButton({
  kbId,
  kbName,
  onDeleted,
}: {
  kbId: string;
  kbName: string;
  onDeleted: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/kb/${encodeURIComponent(kbId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.status === 204 || res.ok) {
        setConfirming(false);
        onDeleted(kbId);
        return;
      }
      if (res.status === 404) setError('知识库不存在或已被删除');
      else setError('删除失败，请稍后重试');
    } catch {
      setError('网络异常，删除请求未完成');
    } finally {
      setDeleting(false);
    }
  };

  if (!confirming) {
    return (
      <button type="button" className="btn-danger kb-delete-btn" onClick={() => setConfirming(true)}>
        删除
      </button>
    );
  }
  return (
    <div className="kb-confirm">
      <p>删除「{kbName}」将同时删除其全部文档、chunks 及会话挂载，确认删除？</p>
      <div className="settings-actions">
        <button type="button" className="btn-danger is-solid" disabled={deleting} onClick={() => void handleDelete()}>
          {deleting ? '删除中…' : '确认删除'}
        </button>
        <button type="button" className="btn-ghost" disabled={deleting} onClick={() => setConfirming(false)}>
          取消
        </button>
      </div>
      {error && <div className="settings-error">{error}</div>}
    </div>
  );
}
