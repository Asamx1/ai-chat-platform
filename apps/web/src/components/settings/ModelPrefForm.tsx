'use client';

import React, { useEffect, useState } from 'react';
import { fetchModelOptions, STORAGE_KEY } from '@/components/chat/ModelPicker';

export default function ModelPrefForm() {
  const [options, setOptions] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchModelOptions().then(models => {
      if (cancelled) return;
      setOptions(models);
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        setModel(stored && models.includes(stored) ? stored : models[0] ?? '');
      } catch {
        setModel(models[0] ?? '');
        setError('无法读取浏览器中的模型偏好');
      }
    });
    return () => { cancelled = true; };
  }, []);

  return <section className="settings-card" aria-labelledby="model-pref-title">
    <div className="settings-card-title"><h2 id="model-pref-title">默认模型偏好</h2></div>
    <div className="login-field">
      <label htmlFor="default-model">默认模型</label>
      <select id="default-model" className="input" value={model} disabled={!options.length}
        onChange={event => {
          setSaved(false);
          setError('');
          try {
            localStorage.setItem(STORAGE_KEY, event.target.value);
            setModel(event.target.value);
            setSaved(true);
          } catch {
            setError('保存失败，请允许浏览器使用本地存储后重试');
          }
        }}>
        {!options.length && <option value="">加载中…</option>}
        {options.map(option => <option key={option} value={option}>{option}</option>)}
      </select>
    </div>
    {!options.length && <p className="skeleton" role="status">加载模型中…</p>}
    <p className="settings-hint">仅保存在当前浏览器，新会话生效。</p>
    {saved && <p role="status">已保存，新会话生效</p>}
    {error && <p className="settings-error" role="alert">{error}</p>}
  </section>;
}
