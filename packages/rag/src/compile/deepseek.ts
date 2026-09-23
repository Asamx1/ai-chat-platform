import { prisma } from '@aichat/db';
import { decrypt } from '@aichat/crypto';

export class DeepSeekCompileError extends Error {
  constructor(readonly code: 'NO_KEY' | 'HTTP_ERROR' | 'INVALID_RESPONSE' | 'TIMEOUT', message?: string) { super(message ?? code); }
}
export type Completion = { content: string; inputTokens: number | null; outputTokens: number | null };

export async function deepseekJson(userId: string, system: string, prompt: string, signal?: AbortSignal): Promise<Completion> {
  const stored = await prisma.apiKey.findUnique({ where: { userId_provider: { userId, provider: 'deepseek' } } });
  if (!stored) throw new DeepSeekCompileError('NO_KEY');
  const key = decrypt(stored.ciphertext);
  const timeout = AbortSignal.timeout(60_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST', signal: combined,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
    });
  } catch (error) {
    throw new DeepSeekCompileError(combined.aborted ? 'TIMEOUT' : 'HTTP_ERROR', String(error));
  }
  if (!response.ok) throw new DeepSeekCompileError('HTTP_ERROR', `DeepSeek HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== 'object') throw new DeepSeekCompileError('INVALID_RESPONSE');
  const body = payload as { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new DeepSeekCompileError('INVALID_RESPONSE');
  return { content, inputTokens: typeof body.usage?.prompt_tokens === 'number' ? body.usage.prompt_tokens : null,
    outputTokens: typeof body.usage?.completion_tokens === 'number' ? body.usage.completion_tokens : null };
}
