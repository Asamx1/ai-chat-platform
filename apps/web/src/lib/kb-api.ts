import { NextResponse } from 'next/server';
import type { Prisma } from '@aichat/db';

export class KbError extends Error {
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.status = status;
  }
}

export function kbError(error: unknown): Response {
  return NextResponse.json({ error: error instanceof KbError ? error.message : 'KB_UNAVAILABLE' },
    { status: error instanceof KbError ? error.status : 503 });
}

export type KbRow = { id: string; name: string };
export type DocumentRow = {
  id: string; name: string; status: string; chunkCount: number; createdAt: Date; error: string | null;
};

export function publicDocument(row: DocumentRow) {
  return {
    id: row.id, name: row.name, status: row.status, chunkCount: row.chunkCount,
    createdAt: row.createdAt.toISOString(),
    error: row.error === null ? null : (/^[A-Z][A-Z0-9_]{0,63}$/.test(row.error) ? row.error : 'DOCUMENT_PROCESSING_FAILED'),
  };
}

// Parameterized SQL keeps this API compatible with the §1 migration before client regeneration.
export async function ownedKb(tx: Prisma.TransactionClient, id: string, userId: string) {
  const rows = await tx.$queryRaw<KbRow[]>`
    SELECT id, name FROM "KnowledgeBase" WHERE id = ${id} AND "userId" = ${userId} FOR UPDATE`;
  if (!rows[0]) throw new KbError('NOT_FOUND', 404);
  return rows[0];
}

export async function documents(tx: Prisma.TransactionClient, kbId: string) {
  const rows = await tx.$queryRaw<DocumentRow[]>`
    SELECT id, name, status, "chunkCount", "createdAt", error FROM "Document"
    WHERE "kbId" = ${kbId} ORDER BY "createdAt", id`;
  return rows.map(publicDocument);
}

export async function readUpload(req: Request): Promise<FormData> {
  const type = req.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('multipart/form-data;')) throw new KbError('UNSUPPORTED_MEDIA_TYPE', 415);
  const length = req.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > 21_000_000)) {
    throw new KbError('PAYLOAD_TOO_LARGE', 413);
  }
  if (!req.body) throw new KbError('INVALID_REQUEST', 400);
  const reader = req.body.getReader();
  let size = 0;
  const bounded = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const value = await reader.read();
        if (value.done) { controller.close(); return; }
        size += value.value.byteLength;
        if (size > 21_000_000) {
          await reader.cancel();
          controller.error(new KbError('PAYLOAD_TOO_LARGE', 413));
        } else controller.enqueue(value.value);
      } catch (error) { controller.error(error); }
    },
    cancel: () => reader.cancel(),
  });
  try {
    return await new Response(bounded, { headers: { 'content-type': type } }).formData();
  } catch {
    await reader.cancel().catch(() => {});
    throw new KbError(size > 21_000_000 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST', size > 21_000_000 ? 413 : 400);
  } finally { reader.releaseLock(); }
}

export async function validateFile(file: File): Promise<Buffer> {
  if (file.size > 20_000_000) throw new KbError('PAYLOAD_TOO_LARGE', 413);
  if (!file.size) throw new KbError('EMPTY_FILE', 400);
  // Never persist client paths as names, or include them in errors/logs.
  if (!file.name || /[\\/\x00-\x1f]/.test(file.name) || file.name.length > 255) throw new KbError('INVALID_REQUEST', 400);
  const ext = file.name.toLowerCase().split('.').at(-1);
  const mime = file.type.toLowerCase();
  const data = Buffer.from(await file.arrayBuffer());
  if (ext === 'pdf' && mime === 'application/pdf') {
    if (!/^%PDF-\d\.\d(?:\s|$)/.test(data.subarray(0, 16).toString('ascii')) ||
        !/%%EOF\s*$/.test(data.subarray(-1024).toString('ascii'))) throw new KbError('UNSUPPORTED_MEDIA_TYPE', 415);
  } else if ((ext === 'txt' && mime === 'text/plain') || (ext === 'md' && (mime === 'text/markdown' || mime === 'text/plain'))) {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
    catch { throw new KbError('UNSUPPORTED_MEDIA_TYPE', 415); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) || text.startsWith('%PDF-')) throw new KbError('UNSUPPORTED_MEDIA_TYPE', 415);
    if (!text.trim()) throw new KbError('EMPTY_FILE', 400);
  } else throw new KbError('UNSUPPORTED_MEDIA_TYPE', 415);
  return data;
}
