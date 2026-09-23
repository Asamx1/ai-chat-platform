'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Citation } from '../../lib/citation-metadata';

function CitationBadge({ citation, number }: { citation: Citation; number: number }) {
  const id = useId();
  const anchor = useRef<HTMLAnchorElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const cancelClose = () => clearTimeout(closeTimer.current);
  const closeSoon = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setPosition(null), 120);
  };
  const open = () => {
    cancelClose();
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - 332)),
      top: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 292)),
    });
  };

  useEffect(() => {
    if (!position) return;
    const dismiss = () => setPosition(null);
    const onScroll = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.citation-popover')) return;
      dismiss();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    window.addEventListener('resize', dismiss);
    // Capture ancestor scrolling as well; the tooltip must not drift away from its badge.
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [position]);
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  return (
    <sup className="citation-badge">
      <a className="badge" ref={anchor} href={`/kb/${encodeURIComponent(citation.documentId)}/chunks`}
        aria-label={`引用 ${number}：${citation.name}，分块 ${citation.ordinal}`}
        aria-describedby={position ? id : undefined}
        onMouseEnter={open} onMouseLeave={closeSoon} onFocus={open} onBlur={closeSoon}>
        [{number}]
      </a>
      {position && createPortal(
        <div id={id} role="tooltip" className="citation-popover" style={position}
          onMouseEnter={cancelClose} onMouseLeave={closeSoon}>
          <strong>{citation.name}</strong>
          <span className="citation-detail">{citation.headingPath.join(' / ') || '无标题'}</span>
          <p>{citation.text}</p>
          <span className="citation-detail">分块 #{citation.ordinal} · 距离 {citation.distance.toFixed(4)}</span>
        </div>, document.body,
      )}
    </sup>
  );
}

export default function CitationBadges({ citations }: { citations: Citation[] }) {
  return citations.map((citation, index) => (
    <CitationBadge key={`${citation.documentId}:${citation.ordinal}:${index}`} citation={citation} number={index + 1} />
  ));
}
