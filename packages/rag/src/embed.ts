import { PermanentRagError } from './parse';
export const EMBEDDING_DIMENSIONS = 1024;
export const embeddingModel = (): string => process.env.EMBEDDING_MODEL || 'bge-m3:latest';
export function validateVector(value: unknown): asserts value is number[] {
  if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSIONS ||
      !value.every(n => typeof n === 'number' && Number.isFinite(n)) || !value.some(n => n !== 0)) {
    throw new PermanentRagError('INVALID_EMBEDDING');
  }
}
/** Queue attempts provide retries; this function never multiplies the attempt budget. */
export async function embed(texts: string[], signal: AbortSignal, model = embeddingModel()): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += 16) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('EMBED_TIMEOUT')), 60_000);
    const combined = AbortSignal.any([signal, timeout.signal]);
    try {
      combined.throwIfAborted();
      const response = await fetch(`${(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '')}/api/embed`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: combined,
        body: JSON.stringify({ model, input: texts.slice(i, i + 16), truncate: false }),
      });
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 429 && response.status !== 408) {
          throw new PermanentRagError(`EMBED_HTTP_${response.status}`);
        }
        throw new Error(`EMBED_HTTP_${response.status}`);
      }
      const body = await response.json() as { embeddings?: unknown };
      if (!Array.isArray(body.embeddings) || body.embeddings.length !== Math.min(16, texts.length - i)) {
        throw new PermanentRagError('INVALID_EMBEDDING_COUNT');
      }
      for (const vector of body.embeddings) { validateVector(vector); vectors.push(vector); }
    } finally { clearTimeout(timer); }
  }
  return vectors;
}
