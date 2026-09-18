/**
 * SSE 编码工具（纯函数，供 /api/runs/[runId]/events 复用）。
 *
 * 帧格式（API 契约冻结）：
 *   id:<seq>\ndata:<JSON>\n\n
 * 心跳为 SSE 注释行：`: heartbeat\n\n`
 */

/** SSE 心跳注释行（注释行不会被 EventSource 触发 message 事件）。 */
export const HEARTBEAT = ': heartbeat\n\n';

/** 到达这些事件类型后，run 的流式推送应当结束。 */
const TERMINAL_EVENT_TYPES = new Set([
  'run.succeeded',
  'run.failed',
  'run.cancelled',
]);

/** 事件 type 是否为 run 终态事件。 */
export function isTerminalEvent(type: string): boolean {
  return TERMINAL_EVENT_TYPES.has(type);
}

/**
 * 把 (id, data) 编成一条 SSE 帧。data 会被 JSON.stringify。
 * sseEncode(3, {...}) => "id: 3\ndata: {...}\n\n"
 */
export function sseEncode(id: number | string, data: unknown): string {
  return `id: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
}
