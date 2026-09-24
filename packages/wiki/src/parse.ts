import { readFile } from 'node:fs/promises';
import type { SourceLocator } from '@aichat/contracts';
import { rawPath, sha256 } from './scan.js';
export interface ParsedDoc { needsOcr: boolean; sections: Array<{ locator: SourceLocator; text: string; sha256: string }> }
export type ParseSource = { filePath: string; mimeType: string; sha256?: string };
export type PdfReader = (bytes: Uint8Array) => Promise<string[]>;
export const readPdf: PdfReader = async bytes => {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true });
  try {
    const document = await task.promise;
    const pages: string[] = [];
    for (let page = 1; page <= document.numPages; page++) {
      const pdfPage = await document.getPage(page);
      try {
        const content = await pdfPage.getTextContent();
        pages.push(content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : '') : '').join(''));
      } finally { pdfPage.cleanup(); }
    }
    return pages;
  } finally { await task.destroy(); }
};
export async function parseSource(source: ParseSource, vaultPath: string, pdf: PdfReader = readPdf): Promise<ParsedDoc> {
  const bytes = await readFile(await rawPath(vaultPath, source.filePath));
  if (source.sha256 && sha256(bytes) !== source.sha256) throw new Error('SOURCE_CHANGED_AFTER_SCAN');
  const sections: ParsedDoc['sections'] = [];
  const add = (locator: SourceLocator, text: string) => { sections.push({ locator, text, sha256: sha256(text) }); };
  if (source.mimeType === 'application/pdf') {
    const pages = await pdf(bytes);
    if (pages.slice(0, 2).join('').trim().length < 60) return { needsOcr: true, sections: [] };
    pages.forEach((text, index) => add({ kind: 'page', page: index + 1 }, text));
  } else if (source.mimeType === 'text/markdown') {
    const text = bytes.toString('utf8');
    const headings = [...text.matchAll(/^#{1,6}[ \t]+(.+)$/gm)];
    let start = 0; let label = 'preamble'; let index = 0;
    for (const heading of headings) {
      if (heading.index > start) add({ kind: 'section', section: `${index}:${label}` }, text.slice(start, heading.index));
      start = heading.index; label = heading[1]!.trim(); index++;
    }
    if (start < text.length) add({ kind: 'section', section: `${index}:${label}` }, text.slice(start));
  } else if (source.mimeType === 'text/plain') {
    const text = bytes.toString('utf8');
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 4000, text.length);
      if (end < text.length) { const lineEnd = text.lastIndexOf('\n', end - 1); if (lineEnd >= start) end = lineEnd + 1; }
      add({ kind: 'offset', start, end }, text.slice(start, end)); start = end;
    }
  } else return { needsOcr: true, sections: [] };
  return { needsOcr: false, sections };
}
