import React from 'react';

/** Safe, dependency-free Markdown subset; incomplete streamed syntax stays readable. */
function inline(text: string): React.ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*') && part.endsWith('*')) return <em key={i}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link && link[2] && /^(https?:\/\/|mailto:)/i.test(link[2])) return <a key={i} href={link[2]} rel="noreferrer">{link[1]}</a>;
    return part;
  });
}

export default function Markdown({ text }: { text: string }) {
  return <>{text.split('```').map((block, i) => {
    if (i % 2) return <pre key={i}><code>{block.replace(/^[\w-]*\n/, '')}</code></pre>;
    return <React.Fragment key={i}>{block.split('\n').map((line, j) => {
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) return <div key={j} role="heading" aria-level={heading[1]?.length ?? 1}><strong>{inline(heading[2] ?? '')}</strong></div>;
      if (line.startsWith('> ')) return <blockquote key={j}>{inline(line.slice(2))}</blockquote>;
      return <div key={j}>{inline(line.replace(/^[-*] /, '• ')) || <br />}</div>;
    })}</React.Fragment>;
  })}</>;
}
