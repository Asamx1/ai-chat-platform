import { createHash } from 'node:crypto';
import type { ChatMessage } from '@aichat/providers';

/**
 * 席位配置（与 @aichat/contracts 的 CollabSeat 字段对齐；本地别名以便纯逻辑复用）。
 */
export interface SeatConfig {
  seatId: string;
  modelId: string;
  role: string;
  systemPrompt: string;
}

export interface BuildSeatContextOptions {
  /** 保留最近 N 条历史消息，默认 20。 */
  maxHistoryMessages?: number;
}

export interface SeatContext {
  messages: ChatMessage[];
  /** sha256(JSON.stringify(messages)) 前 16 位，用于确定性断言（同输入同 hash）。 */
  contextHash: string;
}

const DEFAULT_MAX_HISTORY_MESSAGES = 20;

/**
 * 组装单席位上下文：[system(seat.systemPrompt), ...最近 N 条 history, task]。
 * 纯函数：不修改入参，返回新数组。
 */
export function buildSeatContext(
  seat: SeatConfig,
  history: ChatMessage[],
  task: { role: 'user'; content: string },
  opts?: BuildSeatContextOptions,
): SeatContext {
  const maxHistory = opts?.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
  const trimmed = maxHistory > 0 ? history.slice(-maxHistory) : [];
  const messages: ChatMessage[] = [
    { role: 'system', content: seat.systemPrompt },
    ...trimmed,
    { role: task.role, content: task.content },
  ];
  const contextHash = createHash('sha256').update(JSON.stringify(messages), 'utf8').digest('hex').slice(0, 16);
  return { messages, contextHash };
}

/**
 * 摘要降级：把 messages[0..len-keepLast] 折叠成单条 system 消息
 * '[earlier context omitted: N messages]'，尾部 keepLast 条原样保留。
 * M3 简化版不做真摘要，M5 换 LLM 摘要。返回新数组，不修改入参。
 */
export function rollingSummary(messages: ChatMessage[], keepLast: number): ChatMessage[] {
  if (messages.length <= keepLast) {
    return [...messages];
  }
  const foldedCount = messages.length - keepLast;
  const folded: ChatMessage = {
    role: 'system',
    content: `[earlier context omitted: ${foldedCount} messages]`,
  };
  return [folded, ...messages.slice(-keepLast)];
}
