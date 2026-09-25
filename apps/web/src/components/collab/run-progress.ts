export const STAGES = ['PLANNING', 'ROUND', 'JUDGING', 'SYNTHESIZING'] as const;
export type Stage = typeof STAGES[number];
export interface ProgressEvent { seq?: number; type: string; time?: string; payload?: Record<string, unknown> }
export interface Participant { seatId: string; status: 'running' | 'completed' | 'waiting' | 'ended'; degraded?: string; replacement?: string; round?: number; lastStartedAt?: number }
export interface ProgressState {
  maxSeq: number; stage?: Stage; round?: number; visited: Stage[];
  participants: Record<string, Participant>; ended: boolean; outcome?: string; failed: boolean;
  startedAt?: string; endedAt?: string;
}
export const initialProgress: ProgressState = { maxSeq: 0, visited: [], participants: {}, ended: false, failed: false };
export function reduceProgress(state: ProgressState, event: ProgressEvent): ProgressState {
  if (event.seq != null && event.seq <= state.maxSeq) return state;
  if (state.ended) return state;
  const next = { ...state, maxSeq: Math.max(state.maxSeq, event.seq ?? 0), participants: { ...state.participants } };
  const p = event.payload ?? {};
  const type = event.type.replace(/^collab\./, '');
  const seatId = typeof p.seatId === 'string' ? p.seatId : undefined;
  const participant = (id: string) => ({ ...(next.participants[id] ?? { seatId: id, status: 'waiting' as const }) });
  if (event.type === 'run.started' && !next.startedAt) next.startedAt = event.time ?? new Date().toISOString();
  if (type === 'stage.changed' && STAGES.includes(p.stage as Stage)) {
    next.stage = p.stage as Stage;
    if (typeof p.round === 'number') next.round = p.round;
    else delete next.round;
    next.visited = [...new Set([...state.visited, next.stage])];
  }
  if (seatId) {
    const seat = participant(seatId);
    if (type === 'seat.started') {
      seat.status = 'running';
      seat.lastStartedAt = event.time ? Date.parse(event.time) : Date.now();
    }
    if (type === 'seat.completed') seat.status = 'completed';
    if (type.includes('degraded') || p.degraded === true) seat.degraded = typeof p.reason === 'string' ? p.reason : '异常 / 降级';
    if (typeof p.round === 'number') seat.round = p.round;
    next.participants[seatId] = seat;
  }
  if (type === 'seat.substituted') {
    const from = p.from ?? p.fromSeatId;
    const to = p.to ?? p.toSeatId;
    if (typeof from === 'string' && typeof to === 'string') {
      next.participants[from] = { ...participant(from), status: 'ended', replacement: to, degraded: '已替补' };
      next.participants[to] = participant(to);
    }
  }
  if (event.type === 'run.failed') next.failed = true;
  if (event.type === 'run.succeeded' || event.type === 'run.cancelled' || event.type === 'stream.end') {
    next.ended = true;
    next.endedAt = event.time ?? new Date().toISOString();
    next.outcome = event.type === 'run.succeeded' ? '已完成' : event.type === 'run.cancelled' ? '已取消' : next.failed ? '运行失败' : '已结束、详情缺失';
    for (const [id, seat] of Object.entries(next.participants)) {
      if (seat.status === 'running' || seat.status === 'waiting') next.participants[id] = { ...seat, status: 'ended' };
    }
  }
  return next;
}
export interface UsageValue { calls?: number | null; tokens?: number | null; costMicros?: number | null }
export interface RunUsage { seats: (UsageValue & { seatId: string | null })[]; totals: UsageValue }
