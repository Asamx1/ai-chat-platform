import { normalize, type Part } from './chunk';
export const MAX_FILE_BYTES = 20_000_000;
export const MAX_TEXT_CHARACTERS = 2_000_000;
export class PermanentRagError extends Error {}
export type PdfParser = (data: Uint8Array) => Promise<string>;
/** The worker supplies an isolated PDF parser; importing this module never loads PDF.js. */
export async function parse(data: Uint8Array, mime: string, pdf?: PdfParser): Promise<Part[]> {
  if (data.byteLength > MAX_FILE_BYTES) throw new PermanentRagError('FILE_TOO_LARGE');
  let text: string;
  if (mime === 'application/pdf') {
    if (new TextDecoder().decode(data.subarray(0, 5)) !== '%PDF-') throw new PermanentRagError('INVALID_PDF');
    if (!pdf) throw new PermanentRagError('PDF_REQUIRES_WORKER');
    text = await pdf(data);
  } else if (mime === 'text/plain' || mime === 'text/markdown') {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
    catch { throw new PermanentRagError('INVALID_UTF8'); }
  } else throw new PermanentRagError('UNSUPPORTED_MIME');
  text = normalize(text);
  if (Array.from(text).length > MAX_TEXT_CHARACTERS) throw new PermanentRagError('TEXT_TOO_LARGE');
  if (!text.trim()) throw new PermanentRagError('EMPTY_TEXT_OR_SCANNED_PDF');
  return [{ text }];
}
