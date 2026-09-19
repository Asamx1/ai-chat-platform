'use client';

import { useCallback, useEffect, useState } from 'react';

/** events?format=json 返回的事件（与 SSE data 契约一致） */
interface TimelineEvent {
  seq: number;
  type: string;
  time: string;
  payload: {
    seatId?: string;
    round?: number;
    durationMs?: number;
    fromSeatId?: string;
    toSeatId?: string;
    delta?: string;
    error?: { message?: string };
    [k: string]: unknown;
  };
}

/** usage 路由汇总结构 */
interface SeatUsage {
  seatId: string;
  calls: number;
  tokens: number;
  costMicros: number;
}

/** 席位泳道：started/completed 事件聚合 */
interface SeatLane {
  seatId: string;
  startedAt: string | null;
  durationMs: number | null;
  rounds: number[];
}

/** 事件类型 → 徽章颜色族：run.* 蓝、collab.* 紫、provider.* 灰 */
function typeClass(type: string): string {
  if (type.startsWith('run.')) return 'tl-badge-run';
  if (type.startsWith('collab.')) return 'tl-badge-collab';
  return 'tl-badge-provider';
}

/** provider.delta 等高频事件在时间线里缩略展示 */
function isCompact(type: string): boolean {
  return type === 'provider.delta';
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** payload 摘要：seatId / round / durationMs / 替代 from→to */
function payloadSummary(ev: TimelineEvent): string | null {
  const parts: string[] = [];
  if (ev.payload.seatId) parts.push(`seat=${ev.payload.seatId}`);
  if (ev.payload.round != null) parts.push(`round=${ev.payload.round}`);
  if (ev.payload.durationMs != null) parts.push(formatDuration(ev.payload.durationMs));
  if (ev.type === 'collab.seat.substituted') {
    parts.push(`${ev.payload.fromSeatId ?? '?'} → ${ev.payload.toSeatId ?? '?'}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * 运行时间线：挂载即拉全量事件（events?format=json）+ 用量汇总（usage），
 * 渲染事件流 / 席位泳道 / 成本条，并提供导出（B1）与刷新入口。
 */
export default function RunTimeline({ runId, collapsed = false }: { runId: string; collapsed?: boolean }) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [usage, setUsage] = useState<{ seats: SeatUsage[]; totals: SeatUsage } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(collapsed);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [evRes, usageRes] = await Promise.all([
        fetch(`/api/runs/${runId}/events?after=0&format=json`, { credentials: 'include' }),
        fetch(`/api/runs/${runId}/usage`, { credentials: 'include' }),
      ]);
      if (!evRes.ok) throw new Error(`events HTTP ${evRes.status}`);
      const evBody = (await evRes.json()) as { events: TimelineEvent[] };
      setEvents(evBody.events);
      // usage 404/失败不阻塞时间线，仅隐藏成本条
      if (usageRes.ok) {
        setUsage((await usageRes.json()) as { seats: SeatUsage[]; totals: SeatUsage });
      } else {
        setUsage(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 席位泳道：按 seat.started/completed/substituted 聚合
  const lanes = new Map<string, SeatLane>();
  for (const ev of events) {
    const seatId = ev.payload.seatId ?? ev.payload.toSeatId;
    if (!seatId) continue;
    const lane = lanes.get(seatId) ?? { seatId, startedAt: null, durationMs: null, rounds: [] };
    switch (ev.type) {
      case 'collab.seat.started':
        lane.startedAt = ev.time;
        break;
      case 'collab.seat.completed':
        lane.durationMs = ev.payload.durationMs ?? lane.durationMs;
        break;
      case 'collab.round.completed':
      case 'round.completed':
        if (ev.payload.round != null && !lane.rounds.includes(ev.payload.round)) lane.rounds.push(ev.payload.round);
        break;
      default:
        break;
    }
    lanes.set(seatId, lane);
  }
  const seatLanes = [...lanes.values()].sort((a, b) =>
    a.seatId.localeCompare(b.seatId, undefined, { numeric: true }),
  );

  if (isCollapsed) {
    return (
      <div className="tl-shell">
        <button type="button" className="tl-toggle" onClick={() => setIsCollapsed(false)}>
          ▸ 时间线（{events.length} 事件）
        </button>
      </div>
    );
  }

  return (
    <div className="tl-shell">
      <div className="tl-header">
        <span>时间线 · {runId.slice(0, 8)}</span>
        <div className="tl-actions">
          <button type="button" className="tl-btn" onClick={() => void load()} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
          <a className="tl-btn" href={`/api/runs/${runId}/export`} download>
            导出
          </a>
          <button type="button" className="tl-toggle" onClick={() => setIsCollapsed(true)} aria-label="收起时间线">
            ▾
          </button>
        </div>
      </div>

      {error && <div className="tl-error">{error}</div>}

      {usage && (
        <div className="tl-costbar">
          <span className="tl-cost-total">
            成本 {usage.totals.tokens.toLocaleString()} tokens · ${(usage.totals.costMicros / 1_000_000).toFixed(4)}
          </span>
          {usage.seats.map((s) => (
            <span key={s.seatId} className="tl-cost-seat" title={`${s.calls} 次调用`}>
              {s.seatId}: {s.tokens.toLocaleString()} tok · ${(s.costMicros / 1_000_000).toFixed(4)}
            </span>
          ))}
        </div>
      )}

      {seatLanes.length > 0 && (
        <div className="tl-lanes">
          {seatLanes.map((lane) => (
            <div key={lane.seatId} className="tl-lane">
              <span className="tl-lane-id">{lane.seatId}</span>
              <span className="tl-lane-track">
                {lane.startedAt ? <span className="tl-lane-bar" /> : null}
                <span className="tl-lane-meta">
                  {lane.durationMs != null ? formatDuration(lane.durationMs) : lane.startedAt ? '进行中…' : '待开始'}
                  {lane.rounds.length > 0 ? ` · R${lane.rounds.join(',R')}` : ''}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="tl-stream">
        {events.length === 0 && !loading && <div className="tl-empty">暂无事件</div>}
        {events
          .filter((ev) => !isCompact(ev.type) || ev.seq % 50 === 0) // delta 采样缩略
          .map((ev) => (
            <div key={ev.seq} className={`tl-row${ev.type === 'collab.seat.substituted' ? ' tl-row-subst' : ''}`}>
              <span className="tl-seq">#{ev.seq}</span>
              <span className={`tl-badge ${typeClass(ev.type)}`}>{ev.type}</span>
              <span className="tl-summary">{payloadSummary(ev)}</span>
              <span className="tl-time">{ev.time.slice(11, 19)}</span>
            </div>
          ))}
      </div>
    </div>
  );
}
