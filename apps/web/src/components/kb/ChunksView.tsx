'use client';

import { useMemo, useState } from 'react';
import { parseHeadingPath } from '../../lib/citation-metadata';

export type ChunkRow = {
  id: string;
  parentId: string | null;
  headingPath: string | null;
  kind: string;
  ordinal: number;
  start: number;
  end: number;
  text: string;
};

type Group = { parent: ChunkRow | null; children: ChunkRow[] };

/**
 * 按 small-to-big 结构分组：PARENT 作为组头，CHILD 依 parentId 归组（保持 ordinal 顺序），
 * STANDALONE 与 parentId 已悬空的 CHILD 各自成组。
 */
function groupChunks(rows: ChunkRow[]): Group[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const groups = new Map<string, Group>();
  const ensure = (key: string, parent: ChunkRow | null): Group => {
    let group = groups.get(key);
    if (!group) {
      group = { parent, children: [] };
      groups.set(key, group);
    }
    return group;
  };
  for (const row of rows) {
    if (row.kind === 'PARENT') {
      ensure(row.id, row);
      continue;
    }
    const parent = row.parentId != null ? byId.get(row.parentId) : undefined;
    if (parent && parent.kind === 'PARENT') ensure(parent.id, parent).children.push(row);
    else ensure(`orphan:${row.id}`, null).children.push(row);
  }
  return [...groups.values()];
}

function ChunkText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = !expanded && text.length > 280;
  return (
    <div className="kb-chunk-text">
      <pre>{truncated ? `${text.slice(0, 280)}…` : text}</pre>
      {text.length > 280 && (
        <button type="button" className="kb-chunk-toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起' : '展开全文'}
        </button>
      )}
    </div>
  );
}

/** chunk 预览主体：父块 + 子块缩进列表，kind 徽章 / 标题路径 / ordinal 与偏移。 */
export default function ChunksView({ chunks }: { chunks: ChunkRow[] }) {
  // JSON-encoded select values keep empty/missing headings distinct from “all”.
  const [section, setSection] = useState('all');
  const sections = useMemo(() => [...new Set(chunks.map(chunk =>
    parseHeadingPath(chunk.headingPath)[0] ?? '',
  ))], [chunks]);
  const visible = useMemo(() => chunks.filter(chunk => section === 'all' ||
    JSON.stringify(parseHeadingPath(chunk.headingPath)[0] ?? '') === section), [chunks, section]);
  const groups = useMemo(() => groupChunks(visible), [visible]);
  if (chunks.length === 0) {
    return <p className="kb-empty">该文档还没有 chunk（解析完成后生成）。</p>;
  }
  return (
    <>
    <div className="kb-section-filter">
      <label htmlFor="chunk-section">章节</label>
      <select id="chunk-section" value={section} onChange={event => setSection(event.target.value)}>
        <option value="all">全部章节</option>
        {sections.map(heading => <option key={heading} value={JSON.stringify(heading)}>{heading || '无标题'}</option>)}
      </select>
      <span aria-live="polite">{visible.length} / {chunks.length} chunks</span>
    </div>
    {visible.length === 0 && <p className="kb-empty">该章节没有 chunk。</p>}
    <ul className="kb-chunk-groups">
      {groups.map((group) => {
        const head = group.parent ?? group.children[0]!;
        const heading = parseHeadingPath(head.headingPath).join(' / ');
        return (
          <li key={group.parent?.id ?? head.id} className="kb-chunk-group">
            <div className="kb-chunk-group-title">
              {heading && <span className="kb-chunk-heading" title={heading}>{heading}</span>}
              {group.parent && <span className="kb-badge is-parent">PARENT ×{group.children.length}</span>}
            </div>
            <div className="kb-chunk-items">
              {group.parent && (
                <div className="kb-chunk-item">
                  <div className="kb-chunk-meta">
                    <span className="kb-badge is-parent">PARENT</span>
                    <span>#{group.parent.ordinal}</span>
                    <span>{group.parent.start}–{group.parent.end}</span>
                  </div>
                  <ChunkText text={group.parent.text} />
                </div>
              )}
              {group.children.map((child) => (
                <div key={child.id} className={`kb-chunk-item${group.parent ? ' is-child' : ''}`}>
                  <div className="kb-chunk-meta">
                    <span className={`kb-badge is-${child.kind.toLowerCase()}`}>{child.kind}</span>
                    <span>#{child.ordinal}</span>
                    <span>{child.start}–{child.end}</span>
                  </div>
                  <ChunkText text={child.text} />
                </div>
              ))}
            </div>
          </li>
        );
      })}
    </ul>
    </>
  );
}
