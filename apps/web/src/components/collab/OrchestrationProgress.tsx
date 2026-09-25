'use client';
import { useEffect, useRef, useState } from 'react';
import { useRunProgress } from './useRunProgress';
import { STAGES, type Participant, type ProgressState, type RunUsage, type UsageValue } from './run-progress';

const labels = { PLANNING: '规划', ROUND: '讨论', JUDGING: '评审', SYNTHESIZING: '综合' };

/** 毫秒 → mm:ss（超 1 小时为 h:mm:ss） */
function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function StageBar({ state }: { state: ProgressState }) {
  return <ol className="progress-stages" aria-label="编排阶段">{STAGES.map(stage => <li key={stage} className={state.stage === stage ? 'progress-stage is-current' : state.visited.includes(stage) ? 'progress-stage is-visited' : 'progress-stage'} aria-current={state.stage === stage ? 'step' : undefined}>{labels[stage]}{state.stage === stage && state.round != null ? ` · R${state.round}` : ''}</li>)}</ol>;
}

const STATUS_TEXT = { running: '运行中', completed: '已完成', waiting: '待开始', ended: '已结束' } as const;

export function ParticipantCard({ participant, now }: { participant: Participant; now: number }) {
  const runningElapsed =
    participant.status === 'running' && participant.lastStartedAt != null
      ? now - participant.lastStartedAt
      : null;
  return (
    <article className={`progress-participant is-${participant.status}`}>
      <header className="progress-participant-head">
        <span className={`seat-dot is-${participant.status}`} aria-hidden="true" />
        <strong>{participant.seatId}</strong>
        {participant.round != null && <span className="seat-round">R{participant.round}</span>}
      </header>
      <span className="seat-status">
        {STATUS_TEXT[participant.status]}
        {runningElapsed != null && <span className="seat-elapsed"> · {fmtDuration(runningElapsed)}</span>}
      </span>
      {participant.degraded && <span className="progress-warning">{participant.degraded}</span>}
      {participant.replacement && <span>替补 → {participant.replacement}</span>}
    </article>
  );
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

  // 运行中每秒走表:驱动总耗时与席位运行耗时显示;结束后停表。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state.ended) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.ended]);

  // 总体进度:席位完成数为主,无席位事件时退化为阶段进度;成功收官强制 100%。
  const seats = Object.values(state.participants);
  const doneSeats = seats.filter((s) => s.status === 'completed' || s.status === 'ended').length;
  const seatPct = seats.length > 0 ? (doneSeats / seats.length) * 100 : 0;
  const stagePct = (state.visited.length / STAGES.length) * 100;
  const pct = state.outcome === '已完成' ? 100 : state.ended ? seatPct : Math.max(seatPct, seats.length === 0 ? stagePct : 0);

  const startedAt = state.startedAt ? Date.parse(state.startedAt) : null;
  const elapsed = startedAt != null ? (state.endedAt ? Date.parse(state.endedAt) : now) - startedAt : null;

  return (
    <section className="progress-shell" aria-label="编排进度">
      <h2>编排进度</h2>
      <p role="status">{state.outcome ?? (state.failed ? '尝试失败，等待重试或结束确认' : connection)}</p>

      <div className="progress-overall">
        <div
          className="progress-bar-track"
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="总体进度"
        >
          <div className={`progress-bar-fill${state.ended ? '' : ' is-live'}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="progress-meta">
          <span className="progress-pct">{Math.round(pct)}%</span>
          <span>{seats.length > 0 ? `${doneSeats}/${seats.length} 席位完成` : '等待席位事件'}</span>
          {elapsed != null && <span className="progress-elapsed">⏱ {fmtDuration(elapsed)}</span>}
        </div>
      </div>

      <StageBar state={state} />
      {!state.stage && <p className="progress-hint">等待阶段事件</p>}
      <div className="progress-participants">{seats.map(participant => <ParticipantCard key={participant.seatId} participant={participant} now={now} />)}</div>
      {seats.length === 0 && <p className="progress-hint">暂无参与者事件</p>}
      <UsageSummary usage={usage} stale={stale} />
    </section>
  );
}
