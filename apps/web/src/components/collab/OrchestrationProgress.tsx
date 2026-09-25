'use client';
import { useEffect, useRef } from 'react';
import { useRunProgress } from './useRunProgress';
import { STAGES, type Participant, type ProgressState, type RunUsage, type UsageValue } from './run-progress';

const labels = { PLANNING: '规划', ROUND: '讨论', JUDGING: '评审', SYNTHESIZING: '综合' };
export function StageBar({ state }: { state: ProgressState }) {
  return <ol className="progress-stages" aria-label="编排阶段">{STAGES.map(stage => <li key={stage} className={state.stage === stage ? 'progress-stage is-current' : state.visited.includes(stage) ? 'progress-stage is-visited' : 'progress-stage'} aria-current={state.stage === stage ? 'step' : undefined}>{labels[stage]}{state.stage === stage && state.round != null ? ` · R${state.round}` : ''}</li>)}</ol>;
}
export function ParticipantCard({ participant }: { participant: Participant }) {
  return <article className="progress-participant"><strong>{participant.seatId}</strong><span>{({ running: '运行中', completed: '已完成', waiting: '待开始', ended: '已结束' })[participant.status]}{participant.round != null ? ` · R${participant.round}` : ''}</span>{participant.degraded && <span className="progress-warning">{participant.degraded}</span>}{participant.replacement && <span>替补 → {participant.replacement}</span>}</article>;
}
function usageText(value: UsageValue) {
  return `${value.tokens == null ? '未知' : value.tokens.toLocaleString()} tokens · ${value.costMicros == null ? '成本未知' : `$${(value.costMicros / 1000000).toFixed(4)}`}`;
}
export function UsageSummary({ usage, stale }: { usage: RunUsage | null; stale: boolean }) {
  return <div className="progress-usage"><p>{usage ? `总计 ${usageText(usage.totals)}` : '用量未知'}{stale ? ' · 刷新失败，已显示的数据可能过期' : ''}</p>{usage?.seats.map(seat => <p key={seat.seatId ?? '(unassigned)'}>{seat.seatId ?? '(unassigned)'}：{usageText(seat)}</p>)}</div>;
}
export default function OrchestrationProgress({ runId, onSettled }: { runId: string; onSettled?: (outcome: string) => void }) {
  const { state, usage, stale, connection } = useRunProgress(runId);
  // outcome 首次出现(已完成/已取消/运行失败)时回调一次,供父级刷新消息列表。
  const settledRef = useRef(false);
  useEffect(() => {
    if (!state.outcome || settledRef.current) return;
    settledRef.current = true;
    onSettled?.(state.outcome);
  }, [state.outcome, onSettled]);
  return <section className="progress-shell" aria-label="编排进度"><h2>编排进度</h2><p role="status">{state.outcome ?? (state.failed ? '尝试失败，等待重试或结束确认' : connection)}</p><StageBar state={state} />{!state.stage && <p className="progress-hint">等待阶段事件</p>}<div className="progress-participants">{Object.values(state.participants).map(participant => <ParticipantCard key={participant.seatId} participant={participant} />)}</div>{Object.keys(state.participants).length === 0 && <p className="progress-hint">暂无参与者事件</p>}<UsageSummary usage={usage} stale={stale} /></section>;
}
