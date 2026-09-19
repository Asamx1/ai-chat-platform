'use client';

import { useEffect, useRef, useState } from 'react';

/** SSE 事件（M3 契约）：seat/round/run 三类，字段按需可选 */
interface CollabEvent {
  type: string;
  seatId?: string;
  role?: string;
  round?: number;
  durationMs?: number;
  error?: { message?: string };
}

type SeatState = 'pending' | 'speaking' | 'done';

interface SeatView {
  seatId: string;
  role?: string | undefined;
  state: SeatState;
  durationMs?: number | undefined;
  startedAt?: number | undefined;
}

const TERMINAL_TYPES = new Set(['run.succeeded', 'run.failed', 'run.cancelled']);

/** 席位状态徽标文案 */
function seatStateLabel(s: SeatView, finished: boolean): string {
  if (s.state === 'done') return 'done';
  if (s.state === 'speaking') return 'speaking';
  return finished ? 'done' : 'pending';
}

function formatDuration(ms?: number): string | null {
  if (ms == null) return null;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/**
 * 协作运行时侧栏：EventSource 订阅 /api/runs/[runId]/events，
 * 按 collab.seat.started / collab.seat.completed 渲染席位卡片，
 * round.completed 显示轮次线，run.succeeded 后显示最终答案入口。
 */
export default function SeatStatus({
  runId,
  onClose,
  onViewAnswer,
}: {
  runId: string;
  onClose: () => void;
  /** 最终答案入口回调（由父级决定如何展示） */
  onViewAnswer?: () => void;
}) {
  const [seats, setSeats] = useState<Record<string, SeatView>>({});
  const [rounds, setRounds] = useState<number[]>([]);
  const [succeeded, setSucceeded] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    // 同源直连，浏览器自动重连（服务端 15s 心跳）
    const es = new EventSource(`/api/runs/${runId}/events`);
    esRef.current = es;
    es.onmessage = (ev: MessageEvent<string>) => {
      let evt: CollabEvent;
      try {
        evt = JSON.parse(ev.data) as CollabEvent;
      } catch {
        return;
      }
      switch (evt.type) {
        case 'collab.seat.started':
          setSeats((prev) => ({
            ...prev,
            [evt.seatId ?? '?']: {
              seatId: evt.seatId ?? '?',
              role: evt.role ?? undefined,
              state: 'speaking' as SeatView['state'],
              startedAt: Date.now(),
            },
          }));
          break;
        case 'collab.seat.completed':
          setSeats((prev) => {
            const old = prev[evt.seatId ?? '?'];
            const startedAt = old?.startedAt;
            return {
              ...prev,
              [evt.seatId ?? '?']: {
                seatId: evt.seatId ?? '?',
                role: (evt.role ?? old?.role) ?? undefined,
                state: 'done' as SeatView['state'],
                durationMs:
                  evt.durationMs ?? (startedAt != null ? Date.now() - startedAt : undefined) ?? undefined,
              },
            };
          });
          break;
        case 'round.completed':
          setRounds((prev) => (evt.round != null && !prev.includes(evt.round) ? [...prev, evt.round] : prev));
          break;
        case 'run.succeeded':
          setSucceeded(true);
          es.close();
          break;
        case 'run.failed':
        case 'run.cancelled':
        case 'error':
          setFailed(evt.error?.message ?? (evt.type === 'run.cancelled' ? '已取消' : '运行失败'));
          es.close();
          break;
        default:
          break;
      }
    };
    return () => {
      es.close();
      esRef.current = null;
    };
  }, [runId]);

  const seatList = Object.values(seats).sort((a, b) => a.seatId.localeCompare(b.seatId, undefined, { numeric: true }));

  return (
    <aside className="seat-status">
      <div className="seat-status-header">
        <span>协作运行 · {runId.slice(0, 8)}</span>
        <button type="button" className="seat-status-close" onClick={onClose} aria-label="关闭侧栏">
          ✕
        </button>
      </div>

      <div className="seat-status-body">
        {seatList.length === 0 && <div className="seat-empty">等待席位事件…</div>}
        {seatList.map((s) => (
          <div key={s.seatId} className={`seat-card seat-${s.state}`}>
            <div className="seat-card-top">
              <span className="seat-card-id">{s.seatId}</span>
              <span className="seat-card-role">{s.role ?? '—'}</span>
              <span className={`seat-badge seat-badge-${seatStateLabel(s, succeeded || failed != null)}`}>
                {seatStateLabel(s, succeeded || failed != null)}
              </span>
            </div>
            {(s.state === 'speaking' || s.state === 'done') && (
              <div className="seat-card-meta">
                {s.state === 'speaking' ? '发言中…' : null}
                {s.state === 'done' && s.durationMs != null ? `耗时 ${formatDuration(s.durationMs)}` : null}
              </div>
            )}
          </div>
        ))}

        {rounds.map((r) => (
          <div key={r} className="round-divider">
            <span>Round {r} 完成</span>
          </div>
        ))}

        {failed && <div className="msg-status failed" style={{ padding: '8px' }}>{failed}</div>}

        {succeeded && (
          <button type="button" className="collab-launch-btn" onClick={onViewAnswer}>
            查看最终答案
          </button>
        )}
      </div>
    </aside>
  );
}
