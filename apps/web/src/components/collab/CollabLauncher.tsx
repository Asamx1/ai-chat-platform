'use client';

import { useEffect, useState } from 'react';
import { MODEL_OPTIONS, fetchModelOptions } from '@/components/chat/ModelPicker';

type CollabMode = 'GROUP' | 'CONSENSUS' | 'DEBATE';

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

/** 席位预设模板（决议①）：一键填充席位数量与角色序列 */
const PRESETS = [
  { key: 'quick', label: '2席·快速', count: 2, roles: ['candidate', 'reviewer'] },
  { key: 'standard', label: '3席·标准', count: 3, roles: ['candidate', 'candidate', 'reviewer'] },
  { key: 'deep', label: '5席·深度', count: 5, roles: ['candidate', 'candidate', 'reviewer', 'summarizer', 'synthesizer'] },
] as const;

/** 模式中文名与悬浮说明（决议②） */
const MODE_META: Record<CollabMode, { zh: string; hint: string }> = {
  GROUP: { zh: '自由讨论', hint: '各席位独立作答后汇总,观点并呈' },
  CONSENSUS: { zh: '共识收敛', hint: '多轮互相评论,逐步收敛出一致结论' },
  DEBATE: { zh: '正反交锋', hint: '席位分正反方轮番交锋,评审裁定' },
};

/** 角色中文名（决议②） */
const ROLE_META: Record<SeatRole, { zh: string }> = {
  candidate: { zh: '候选作答' },
  reviewer: { zh: '审校把关' },
  summarizer: { zh: '要点提炼' },
  synthesizer: { zh: '综合成稿' },
};

/** tokenBudget 档位（决议③） */
const BUDGET_TIERS = [
  { key: 'lite', label: '省', value: 40000 },
  { key: 'std', label: '标准', value: 100000 },
  { key: 'rich', label: '充足', value: 250000 },
] as const;

const STORAGE_KEY = 'aichat.collab.lastConfig';

interface StoredConfig {
  mode?: unknown;
  seats?: unknown;
  tokenBudget?: unknown;
}

/** 读回上次配置：逐项校验，不合法字段回退默认（决议④） */
function loadStoredConfig(): { mode: CollabMode; seats: SeatDraft[]; tokenBudget: number } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw) as StoredConfig;
    if (cfg == null || typeof cfg !== 'object') return null;
    const mode: CollabMode =
      cfg.mode === 'GROUP' || cfg.mode === 'CONSENSUS' || cfg.mode === 'DEBATE' ? cfg.mode : 'GROUP';
    const budget = typeof cfg.tokenBudget === 'number' && Number.isFinite(cfg.tokenBudget) && cfg.tokenBudget > 0
      ? cfg.tokenBudget
      : 100000;
    if (!Array.isArray(cfg.seats) || cfg.seats.length < 2) return null;
    const seats = cfg.seats.map((s: unknown, i: number) => {
      const seat = (s ?? {}) as Partial<SeatDraft>;
      return {
        seatId: seatId(i + 1),
        modelId: typeof seat.modelId === 'string' && seat.modelId ? seat.modelId : MODEL_OPTIONS[i % MODEL_OPTIONS.length]!,
        role: ROLES.includes(seat.role as never) ? (seat.role as SeatRole) : ('candidate' as SeatRole),
        systemPrompt: typeof seat.systemPrompt === 'string' ? seat.systemPrompt.slice(0, 80) : '',
      };
    });
    return { mode, seats, tokenBudget: budget };
  } catch {
    return null;
  }
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
  const state = loadStoredConfig();
  const [mode, setMode] = useState<CollabMode>(() => state?.mode ?? 'GROUP');
  const [seats, setSeats] = useState<SeatDraft[]>(() => state?.seats ?? initialSeats());
  const [tokenBudget, setTokenBudget] = useState(state?.tokenBudget ?? 100000);
  const [budgetCustom, setBudgetCustom] = useState(
    () => !BUDGET_TIERS.some((t) => t.value === (state?.tokenBudget ?? 100000)),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [topic, setTopic] = useState('');
  const [modelOptions, setModelOptions] = useState<string[]>(MODEL_OPTIONS);

  const disabled = !conversationId;

  /** 席位默认模型：以注册表拉取结果为准（含云端模型） */
  const pickModel = (i: number) => modelOptions[i % modelOptions.length] ?? MODEL_OPTIONS[0]!;

  // 挂载后拉取 /api/models（30s 缓存）：席位下拉改为注册表全量模型;
  // 已选模型不在注册表(未注册/已下线)时自动切到第一个可用模型。
  useEffect(() => {
    let cancelled = false;
    fetchModelOptions().then((models) => {
      if (cancelled || models.length === 0) return;
      setModelOptions(models);
      setSeats((prev) =>
        prev.map((s) => (models.includes(s.modelId) ? s : { ...s, modelId: models[0]! })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const patchSeat = (idx: number, patch: Partial<SeatDraft>) =>
    setSeats((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));

  /** 增删席位后统一重排 seatId 为 s1..sN */
  const renumber = (next: SeatDraft[]) => next.map((s, i) => ({ ...s, seatId: seatId(i + 1) }));

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    setSeats(
      Array.from({ length: preset.count }, (_, i) => ({
        seatId: seatId(i + 1),
        modelId: pickModel(i),
        role: (preset.roles[i] ?? 'candidate') as SeatRole,
        systemPrompt: '',
      })),
    );
  };

  const isPresetActive = (preset: (typeof PRESETS)[number]) =>
    seats.length === preset.count && seats.every((s, i) => s.role === preset.roles[i]);

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
          content: topic.trim(),
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const { runId } = (await res.json()) as { runId: string };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode, seats, tokenBudget }));
      } catch {
        /* 存储不可用时静默降级为不记忆 */
      }
      setTopic('');
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
          {/* 议题输入:留空则回退为会话内最新一条用户消息 */}
          <div className="collab-field">
            <span className="collab-label">议题</span>
            <textarea
              className="input input-focus collab-topic-input"
              rows={3}
              placeholder="输入本次协作要讨论的问题;留空则取会话内最新一条消息"
              value={topic}
              aria-label="议题"
              onChange={(e) => setTopic(e.target.value)}
            />
          </div>

          {/* 模式选择：DEBATE 已解锁（决议①前置） */}
          <div className="collab-field">
            <span className="collab-label">模式</span>
            <div className="collab-modes">
              {(['GROUP', 'CONSENSUS', 'DEBATE'] as const).map((m) => (
                <label key={m} className={`collab-mode ${mode === m ? 'active' : ''}`} title={MODE_META[m].hint}>
                  <input
                    type="radio"
                    name="collab-mode"
                    checked={mode === m}
                    onChange={() => setMode(m)}
                  />
                  {m}·{MODE_META[m].zh}
                </label>
              ))}
            </div>
            <div className="collab-mode-hint">{MODE_META[mode].hint}</div>
          </div>

          {/* 席位编辑器（2-6）+ 预设模板 */}
          <div className="collab-field">
            <span className="collab-label">席位（{seats.length}）</span>
            <div className="collab-presets">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  className={`preset-chip${isPresetActive(p) ? ' is-active' : ''}`}
                  onClick={() => applyPreset(p)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {seats.map((s, i) => (
              <div key={i} className="collab-seat-row">
                <span className="collab-seat-id">{s.seatId}</span>
                <select
                  className="model-select"
                  value={s.modelId}
                  aria-label={`${s.seatId} 模型`}
                  onChange={(e) => patchSeat(i, { modelId: e.target.value })}
                >
                  {(modelOptions.includes(s.modelId) ? modelOptions : [s.modelId, ...modelOptions]).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <select
                  className="model-select"
                  value={s.role}
                  aria-label={`${s.seatId} 角色`}
                  title={ROLE_META[s.role].zh}
                  onChange={(e) => patchSeat(i, { role: e.target.value as SeatRole })}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}·{ROLE_META[r].zh}
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
                      modelId: pickModel(prev.length),
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

          {/* tokenBudget 档位化（决议③） */}
          <div className="collab-field">
            <span className="collab-label">tokenBudget</span>
            <div className="collab-presets" title="token 预算上限">
              {BUDGET_TIERS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={`preset-chip budget-chip${!budgetCustom && tokenBudget === t.value ? ' is-active' : ''}`}
                  onClick={() => {
                    setBudgetCustom(false);
                    setTokenBudget(t.value);
                  }}
                >
                  {t.label} {t.value.toLocaleString()}
                </button>
              ))}
              <button
                type="button"
                className={`preset-chip budget-chip${budgetCustom ? ' is-active' : ''}`}
                onClick={() => setBudgetCustom(true)}
              >
                自定义
              </button>
            </div>
            {budgetCustom && (
              <input
                type="number"
                className="collab-budget-input"
                value={tokenBudget}
                min={1}
                aria-label="tokenBudget"
                title="token 预算上限"
                onChange={(e) => setTokenBudget(Number(e.target.value))}
              />
            )}
          </div>

          {error && <div className="collab-error">{error}</div>}

          <button
            type="button"
            className={`collab-launch-btn${submitting ? ' is-loading' : ''}`}
            disabled={submitting}
            onClick={launch}
          >
            {submitting ? '发起中…' : '发起'}
          </button>
        </div>
      )}
    </div>
  );
}
