'use client';

import { type FormEvent, useState } from 'react';

type Hit = {
  chunkId: string;
  documentId: string;
  name: string;
  chunkStrategy: string | null;
  kind: string | null;
  ordinal: number;
  text: string;
  distance: number;
};

/**
 * 检索试验台：查询输入 + 只读的策略/开关展示 + 命中列表（文本 / 距离 / 策略与 kind）。
 * 策略下拉仅为筛选提示（服务端预览按 kb 全量检索，不按策略过滤）。
 */
export default function PlaygroundForm({
  kbId,
  strategies,
  switches,
}: {
  kbId: string;
  strategies: string[];
  switches: Record<string, boolean>;
}) {
  const [query, setQuery] = useState('');
  const [strategy, setStrategy] = useState(strategies[0] ?? 'structure');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!query.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/kb/${kbId}/playground`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ query: query.trim() }),
      });
      if (!res.ok) {
        setError(res.status === 401 ? '登录已过期，请重新登录' : '检索失败');
        setHits(null);
        return;
      }
      const data = (await res.json()) as { hits?: Hit[] };
      setHits(data.hits ?? []);
    } catch {
      setError('网络异常，检索失败');
      setHits(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="settings-card">
        <div className="settings-card-title">
          <h2>查询</h2>
        </div>
        <form className="settings-form" onSubmit={run}>
          <label className="settings-hint" htmlFor="pg-query">查询文本</label>
          <input
            id="pg-query"
            className="login-input"
            value={query}
            maxLength={2000}
            placeholder="输入要检索的问题…"
            onChange={(event) => setQuery(event.target.value)}
          />
          <label className="settings-hint" htmlFor="pg-strategy">Chunk 策略（展示）</label>
          <select
            id="pg-strategy"
            className="login-input"
            value={strategy}
            onChange={(event) => setStrategy(event.target.value)}
          >
            {strategies.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <div className="settings-hint">检索增强开关（服务端环境，只读）</div>
          <div className="kb-pg-switches">
            {Object.entries(switches).map(([name, value]) => (
              <span key={name} className={`kb-badge ${value ? 'is-ready' : 'is-empty'}`}>
                {name} {value ? 'ON' : 'OFF'}
              </span>
            ))}
          </div>
          <div className="settings-actions">
            <button className="btn-primary" type="submit" disabled={busy || !query.trim()}>
              {busy ? '检索中…' : '检索'}
            </button>
          </div>
        </form>
        {error && <div className="settings-error">{error}</div>}
      </section>

      {hits !== null && (
        <section className="settings-card">
          <div className="settings-card-title">
            <h2>命中结果（{hits.length}）</h2>
          </div>
          {hits.length === 0 ? (
            <p className="kb-empty">没有命中（文档需处于 READY 状态才会被检索）。</p>
          ) : (
            <ul className="kb-list">
              {hits.map((hit) => (
                <li key={hit.chunkId} className="kb-item">
                  <div className="kb-item-main">
                    <div className="kb-item-title">
                      <span className="kb-name">{hit.name}</span>
                      <span className="kb-badge is-empty">{hit.kind ?? 'CHUNK'}</span>
                      <span className="kb-badge is-empty">{hit.chunkStrategy ?? '—'}</span>
                    </div>
                    <div className="kb-item-meta">
                      <span>#{hit.ordinal}</span>
                      <span>distance {hit.distance.toFixed(4)}</span>
                    </div>
                    <p className="kb-pg-hit-text">{hit.text}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
