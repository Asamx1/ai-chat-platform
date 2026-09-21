'use client';

import { KB_STATUS_TEXT, kbStatus, type KnowledgeBase } from './types';
import KbDeleteButton from './KbDeleteButton';

/** 时间显示：相对友好格式（当日 HH:mm，否则 YYYY-MM-DD） */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/**
 * 知识库列表：名称 / 状态徽章 / chunk 数 / 时间 / 删除。
 */
export default function KbList({
  items,
  onDeleted,
}: {
  items: KnowledgeBase[];
  onDeleted: (id: string) => void;
}) {
  if (items.length === 0) {
    return <p className="kb-empty">还没有知识库，上传第一个文件开始构建。</p>;
  }
  return (
    <ul className="kb-list">
      {items.map((kb) => {
        const status = kbStatus(kb);
        const chunkCount = (kb.documents ?? []).reduce((n, d) => n + (d.chunkCount ?? 0), 0);
        const updatedAt = (kb.documents ?? [])
          .map((d) => d.createdAt)
          .filter(Boolean)
          .sort()
          .pop();
        return (
          <li key={kb.id} className="kb-item">
            <div className="kb-item-main">
              <div className="kb-item-title">
                <span className="kb-name">{kb.name}</span>
                <span className={`kb-badge is-${status.toLowerCase()}`}>{KB_STATUS_TEXT[status]}</span>
              </div>
              <div className="kb-item-meta">
                <span>{(kb.documents ?? []).length} 个文档</span>
                <span>{chunkCount} chunks</span>
                {updatedAt && <span>{fmtTime(updatedAt)}</span>}
              </div>
              {status === 'FAILED' &&
                (kb.documents ?? [])
                  .filter((d) => d.status === 'FAILED' && d.error)
                  .slice(0, 1)
                  .map((d) => (
                    <div key={d.id} className="kb-error">
                      {d.name}：{d.error}
                    </div>
                  ))}
            </div>
            <KbDeleteButton kbId={kb.id} kbName={kb.name} onDeleted={onDeleted} />
          </li>
        );
      })}
    </ul>
  );
}
