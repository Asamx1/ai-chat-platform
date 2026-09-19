'use client';

import { useState } from 'react';
import { MODEL_OPTIONS } from '@/components/chat/ModelPicker';

type CollabMode = 'GROUP' | 'CONSENSUS';

const ROLES = ['candidate', 'reviewer', 'summarizer', 'synthesizer'] as const;
type SeatRole = (typeof ROLES)[number];

interface SeatDraft {
  seatId: string;
  modelId: string;
  role: SeatRole;
  systemPrompt: string;
}

const seatId = (n: number) => `s${n}`;

function initialSeats(count = 3): SeatDraft[] {
  return Array.from({ length: count }, (_, i) => ({
    seatId: seatId(i + 1),
    modelId: MODEL_OPTIONS[i % MODEL_OPTIONS.length]!,
    role: 'candidate' as SeatRole,
    systemPrompt: '',
  }));
}

/**
 * 协作发起浮层面板：默认收起，点击「发起协作」展开。
 * 配置 mode / seats(2-6) / tokenBudget 后 POST /api/collab/run。
 */
export default function CollabLauncher({
  conversationId,
  onLaunched,
}: {
  /** 当前会话 id；为空时由父级禁用入口 */
  conversationId: string | null;
  onLaunched: (runId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<CollabMode>('GROUP');
  const [seats, setSeats] = useState<SeatDraft[]>(initialSeats);
  const [tokenBudget, setTokenBudget] = useState(100000);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disabled = !conversationId;

  const patchSeat = (idx: number, patch: Partial<SeatDraft>) =>
    setSeats((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));

  /** 增删席位后统一重排 seatId 为 s1..sN */
  const renumber = (next: SeatDraft[]) => next.map((s, i) => ({ ...s, seatId: seatId(i + 1) }));

  const launch = async () => {
    if (!conversationId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/collab/run', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          mode,
          seats: seats.map(({ seatId: sid, modelId, role, systemPrompt }) => ({
            seatId: sid,
            modelId,
            role,
            systemPrompt,
          })),
          tokenBudget,
          content: '',
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const { runId } = (await res.json()) as { runId: string };
      setOpen(false);
      onLaunched(runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : '发起失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="collab-launcher">
      <button
        type="button"
        className="collab-toggle-btn"
        disabled={disabled}
        title={disabled ? '需先选择一个会话' : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        发起协作
      </button>
      {open && !disabled && (
        <div className="collab-panel">
          {/* 模式选择：DEBATE 置灰，M4 交付 */}
          <div className="collab-field">
            <span className="collab-label">模式</span>
            <div className="collab-modes">
              {(['GROUP', 'CONSENSUS'] as const).map((m) => (
                <label key={m} className={`collab-mode ${mode === m ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="collab-mode"
                    checked={mode === m}
                    onChange={() => setMode(m)}
                  />
                  {m}
                </label>
              ))}
              <label className="collab-mode disabled" title="M4 交付">
                <input type="radio" name="collab-mode" disabled />
                DEBATE
              </label>
            </div>
          </div>

          {/* 席位编辑器（2-6） */}
          <div className="collab-field">
            <span className="collab-label">席位（{seats.length}）</span>
            {seats.map((s, i) => (
              <div key={i} className="collab-seat-row">
                <span className="collab-seat-id">{s.seatId}</span>
                <select
                  className="model-select"
                  value={s.modelId}
                  aria-label={`${s.seatId} 模型`}
                  onChange={(e) => patchSeat(i, { modelId: e.target.value })}
                >
                  {MODEL_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <select
                  className="model-select"
                  value={s.role}
                  aria-label={`${s.seatId} 角色`}
                  onChange={(e) => patchSeat(i, { role: e.target.value as SeatRole })}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="collab-seat-remove"
                  disabled={seats.length <= 2}
                  title={seats.length <= 2 ? '至少 2 个席位' : undefined}
                  onClick={() => setSeats((prev) => renumber(prev.filter((_, j) => j !== i)))}
                >
                  ✕
                </button>
                <input
                  type="text"
                  className="collab-prompt-input"
                  placeholder="systemPrompt（≤80 字）"
                  value={s.systemPrompt}
                  maxLength={80}
                  aria-label={`${s.seatId} systemPrompt`}
                  onChange={(e) => patchSeat(i, { systemPrompt: e.target.value })}
                />
              </div>
            ))}
            <button
              type="button"
              className="collab-seat-add"
              disabled={seats.length >= 6}
              onClick={() =>
                setSeats((prev) =>
                  renumber([
                    ...prev,
                    {
                      seatId: seatId(prev.length + 1),
                      modelId: MODEL_OPTIONS[prev.length % MODEL_OPTIONS.length]!,
                      role: 'candidate' as SeatRole,
                      systemPrompt: '',
                    },
                  ]),
                )
              }
            >
              + 添加席位（最多 6）
            </button>
          </div>

          {/* tokenBudget */}
          <div className="collab-field">
            <span className="collab-label">tokenBudget</span>
            <input
              type="number"
              className="collab-budget-input"
              value={tokenBudget}
              min={1}
              aria-label="tokenBudget"
              onChange={(e) => setTokenBudget(Number(e.target.value))}
            />
          </div>

          {error && <div className="msg-status failed">{error}</div>}

          <button type="button" className="collab-launch-btn" disabled={submitting} onClick={launch}>
            {submitting ? '发起中…' : '发起'}
          </button>
        </div>
      )}
    </div>
  );
}
