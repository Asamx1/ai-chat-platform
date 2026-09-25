'use client';

import { useEffect, useState } from 'react';

export const STORAGE_KEY = 'chat:modelKey';
// 本地 Ollama 模型：仅作为 /api/models 不可用时的兜底选项（CollabLauncher 也复用）。
// 必须是 ModelRegistry 中已注册（且为默认本地模型）的 modelKey，否则后端会直接拒绝/执行失败。
export const MODEL_OPTIONS = ['qwen3:8b'];

export function getStoredModel(): string {
  if (typeof window === 'undefined') return MODEL_OPTIONS[0]!;
  return localStorage.getItem(STORAGE_KEY) ?? MODEL_OPTIONS[0]!;
}

interface ModelOption {
  id: string;
  label?: string;
}

/** /api/models 结果的模块级内存缓存（30s），跨组件实例共享 */
let cache: { at: number; models: string[] } | null = null;
const CACHE_TTL = 30_000;

export async function fetchModelOptions(): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache.models;
  try {
    const res = await fetch('/api/models', { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { models?: ModelOption[] };
    const models = (data.models ?? []).map((m) => m.id).filter(Boolean);
    if (models.length === 0) throw new Error('empty models');
    cache = { at: Date.now(), models };
    return models;
  } catch {
    // 失败兜底：显示原两个本地模型
    return MODEL_OPTIONS;
  }
}

export default function ModelPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
}) {
  const [options, setOptions] = useState<string[]>(MODEL_OPTIONS);

  // 仅用于客户端挂载后同步 localStorage（SSR 首帧用默认值，避免 hydration 不一致）
  const [, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && stored !== value) onChange(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchModelOptions().then((models) => {
      if (cancelled || models.length === 0) return;
      setOptions(models);
      // 存储值不在可用列表(如历史遗留/未注册模型)时,自动切到第一个可用模型
      if (!models.includes(value)) {
        const first = models[0]!;
        localStorage.setItem(STORAGE_KEY, first);
        onChange(first);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <select
      className="input input-focus model-select"
      value={options.includes(value) ? value : (options[0] ?? value)}
      disabled={disabled}
      aria-label="选择模型"
      onChange={(e) => {
        localStorage.setItem(STORAGE_KEY, e.target.value);
        onChange(e.target.value);
      }}
    >
      {options.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}
