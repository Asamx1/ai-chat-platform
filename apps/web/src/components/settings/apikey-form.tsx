'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** GET /api/keys 条目 */
interface KeyInfo {
  provider: string;
  maskedKey: string;
  verified: boolean;
  updatedAt: string;
}

/** GET /api/models 条目 */
interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  kind: 'cloud' | 'local';
  available: boolean;
  keySource: 'db' | 'env' | null;
  quotaRemaining: number | null;
}

type Toast = { kind: 'success' | 'error'; text: string } | null;

export default function ApiKeyForm() {
  const [keyInfo, setKeyInfo] = useState<KeyInfo | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  // 编辑态：首次空态 / 点「更换密钥」后进入
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((kind: 'success' | 'error', text: string) => {
    setToast({ kind, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [keyRes, modelRes] = await Promise.all([
        fetch('/api/keys', { credentials: 'include' }),
        fetch('/api/models', { credentials: 'include' }),
      ]);
      if (keyRes.ok) {
        const data = (await keyRes.json()) as { keys: KeyInfo[] };
        const info = data.keys?.find((k) => k.provider === 'deepseek') ?? null;
        setKeyInfo(info);
        setEditing(!info);
      }
      if (modelRes.ok) {
        const data = (await modelRes.json()) as { models: ModelInfo[] };
        setModels(data.models ?? []);
      }
    } catch {
      /* 网络异常：保持空态表单，用户可稍后重试 */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSave = useCallback(async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setError('请输入 API Key');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'deepseek', apiKey: trimmed }),
      });
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as { maskedKey?: string } | null;
        setApiKey('');
        setEditing(false);
        if (data?.maskedKey) {
          setKeyInfo({
            provider: 'deepseek',
            maskedKey: data.maskedKey,
            verified: true,
            updatedAt: new Date().toISOString(),
          });
        }
        showToast('success', '密钥已保存，校验通过');
        // 掩码与模型状态以服务端为准，重新拉取
        await refresh();
        return;
      }
      if (res.status === 401) {
        setError('密钥校验失败，请检查 API Key 是否正确');
      } else if (res.status === 400 || res.status === 502) {
        setError('密钥校验失败，请检查 API Key 是否正确');
      } else {
        setError('网络异常，校验请求未完成，请稍后重试');
      }
    } catch {
      setError('网络异常，校验请求未完成，请稍后重试');
    } finally {
      setSaving(false);
    }
  }, [apiKey, refresh, showToast]);

  const handleDelete = useCallback(async () => {
    try {
      const res = await fetch('/api/keys?provider=deepseek', {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.status === 204 || res.ok) {
        setKeyInfo(null);
        setEditing(true);
        setConfirming(false);
        setApiKey('');
        showToast('success', '密钥已删除');
        await refresh();
      } else {
        showToast('error', '网络异常，校验请求未完成，请稍后重试');
      }
    } catch {
      showToast('error', '网络异常，校验请求未完成，请稍后重试');
    }
  }, [refresh, showToast]);

  const cloudModels = models.filter((m) => m.kind === 'cloud').slice(0, 2);
  const hasKey = Boolean(keyInfo?.maskedKey);

  return (
    <div className="page-shell">
      {toast && <div className={`settings-toast is-${toast.kind}`}>{toast.text}</div>}
      <a className="btn page-back" href="/">
        ← 返回聊天
      </a>
      <header className="page-header">
        <h1>设置</h1>
        <p>管理你的 API 密钥与模型可用性</p>
      </header>

      <section className="settings-card">
        <div className="settings-card-title">
          <h2>DeepSeek API 密钥</h2>
          <span className={`badge ${hasKey ? 'is-ok' : 'is-empty'}`}>
            {hasKey ? '已配置' : '未配置'}
          </span>
        </div>

        {!editing && keyInfo ? (
          <>
            <div className="settings-mask-label">当前密钥</div>
            <div className="settings-mask">{keyInfo.maskedKey}</div>
            <div className="settings-actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setEditing(true);
                  setApiKey('');
                  setError(null);
                  setConfirming(false);
                }}
              >
                更换密钥
              </button>
              <button type="button" className="btn btn-danger" onClick={() => setConfirming(true)}>
                删除
              </button>
            </div>
            {confirming && (
              <div className="settings-confirm">
                <p>删除后需重新配置密钥才能继续聊天，确认删除？</p>
                <div className="settings-actions">
                  <button
                    type="button"
                    className="btn btn-danger is-solid"
                    onClick={() => void handleDelete()}
                  >
                    确认删除
                  </button>
                  <button type="button" className="btn" onClick={() => setConfirming(false)}>
                    取消
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            {keyInfo?.maskedKey && (
              <p className="settings-overwrite">
                当前已配置 {keyInfo.maskedKey}，保存新密钥后将覆盖。
              </p>
            )}
            {!keyInfo && (
              <p className="settings-desc">配置你自己的 DeepSeek API Key，用于调用对话与推理模型。</p>
            )}
            <form
              className="settings-form"
              onSubmit={(e) => {
                e.preventDefault();
                void handleSave();
              }}
            >
              <div className="login-field">
                <label htmlFor="deepseek-api-key">API Key</label>
                <input
                  id="deepseek-api-key"
                  className="input"
                  type="password"
                  placeholder="sk-..."
                  value={apiKey}
                  autoComplete="off"
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <small className="settings-hint">密钥仅存储于服务端，保存后不再显示明文。</small>
              </div>
              <div className="settings-actions">
                <button type="submit" className={`btn btn-primary${saving ? ' is-loading' : ''}`} disabled={saving}>
                  {saving ? '校验中…' : '保存并校验'}
                </button>
                {keyInfo && (
                  <button
                    type="button"
                    className="btn"
                    disabled={saving}
                    onClick={() => {
                      setEditing(false);
                      setApiKey('');
                      setError(null);
                    }}
                  >
                    取消
                  </button>
                )}
              </div>
            </form>
            {error && <div className="settings-error">{error}</div>}
          </>
        )}
      </section>

      <section className="settings-card">
        <div className="settings-card-title">
          <h2>模型状态</h2>
        </div>
        {!loaded && <p className="skeleton" role="status">加载模型中…</p>}
        {(loaded && cloudModels.length === 0 ? fallbackModelRows() : cloudModels).map((m) => (
          <div key={m.id} className={`settings-model-item ${m.available ? 'is-on' : 'is-off'}`}>
            <div>
              <span className="settings-model-name">{m.label || m.id}</span>
              <small className="settings-model-desc">{m.id === 'deepseek-reasoner' ? '推理模型' : '对话模型'}</small>
            </div>
            <div className="settings-model-state">
              <span className="settings-model-dot" />
              {m.available ? '可用' : '未配置密钥'}
            </div>
          </div>
        ))}
      </section>

      <footer className="settings-note">
        密钥加密存储，仅用于服务端请求 DeepSeek 接口，不会用于其他用途。
      </footer>
    </div>
  );
}

/** /api/models 未就绪/失败时的静态兜底展示 */
function fallbackModelRows(): ModelInfo[] {
  return [
    { id: 'deepseek-chat', label: 'deepseek-chat', provider: 'deepseek', kind: 'cloud', available: false, keySource: null, quotaRemaining: null },
    { id: 'deepseek-reasoner', label: 'deepseek-reasoner', provider: 'deepseek', kind: 'cloud', available: false, keySource: null, quotaRemaining: null },
  ];
}
