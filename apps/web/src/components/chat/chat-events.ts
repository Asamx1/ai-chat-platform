import type { ChatMessage } from './types';

export interface RunEvent {
  type: string;
  payload?: { delta?: string; error?: unknown };
  // Compatibility with older flattened events.
  delta?: string;
  error?: unknown;
}

export function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    if (typeof error.message === 'string' && error.message.trim()) return error.message;
  }
  return fallback;
}

export async function sendFailure(response: Response): Promise<string> {
  const body = await response.json().catch(() => null);
  return errorMessage(body?.error, `发送失败（HTTP ${response.status}），请稍后重试。`);
}

export function applyRunEvent(message: ChatMessage, event: RunEvent, retryKey: string): ChatMessage {
  switch (event.type) {
    case 'provider.delta':
      return { ...message, content: message.content + (event.payload?.delta ?? event.delta ?? '') };
    case 'run.succeeded':
      return { ...message, status: 'succeeded', retryIdempotencyKey: undefined };
    case 'run.failed':
    case 'error':
      return {
        ...message,
        status: event.type === 'run.failed' ? 'failed' : 'error',
        error: errorMessage(event.payload?.error ?? event.error, '生成失败，请稍后重试。'),
        retryIdempotencyKey: retryKey,
      };
    case 'run.cancelled':
      return { ...message, status: 'cancelled' };
    default:
      return message;
  }
}
