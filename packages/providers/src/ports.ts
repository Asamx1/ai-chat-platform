import type { Usage } from '@aichat/contracts';

export interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  parallelTools: boolean;
  jsonSchema: boolean;
  reasoningVisibility: boolean;
  usageStreaming: boolean;
  cancel: boolean;
  vision: boolean;
  maxContext: number;
  maxOutput: number;
}

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export type ProviderStreamEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'error'; error: string }
  | { type: 'done'; finishReason: string };

export interface StreamChatOptions {
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}

export interface ProviderAdapter {
  capabilities(): ProviderCapabilities;
  streamChat(messages: ChatMessage[], opts?: StreamChatOptions): AsyncIterable<ProviderStreamEvent>;
}
