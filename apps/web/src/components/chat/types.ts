export interface Conversation {
  id: string;
  title: string;
  updatedAt?: string;
}

export type MessageStatus =
  | 'streaming'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'error';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  error?: string | undefined;
  /** assistant 流式消息的状态角标 */
  status?: MessageStatus | undefined;
  /** 失败/出错时可重试的 idempotencyKey */
  retryIdempotencyKey?: string | undefined;
}
