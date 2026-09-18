'use client';

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'chat:modelKey';
// 本地 Ollama 模型，硬编码选项
export const MODEL_OPTIONS = ['qwen3:0.6b', 'qwen3.6:latest'];

export function getStoredModel(): string {
  if (typeof window === 'undefined') return MODEL_OPTIONS[0]!;
  return localStorage.getItem(STORAGE_KEY) ?? MODEL_OPTIONS[0]!;
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
  // 仅用于客户端挂载后同步 localStorage（SSR 首帧用默认值，避免 hydration 不一致）
  const [, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && stored !== value) onChange(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <select
      className="model-select"
      value={value}
      disabled={disabled}
      aria-label="选择模型"
      onChange={(e) => {
        localStorage.setItem(STORAGE_KEY, e.target.value);
        onChange(e.target.value);
      }}
    >
      {MODEL_OPTIONS.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}
