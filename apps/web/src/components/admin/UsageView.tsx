'use client';

import { useEffect, useState } from 'react';
import { adminRequest } from './api';
interface UsageRow { date: string; userId: string; modelId: string; tokens: string }
const utcDate = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
export default function UsageView() {
  const [from, setFrom] = useState(() => utcDate(-6));
  const [to, setTo] = useState(() => utcDate(1));
  const [userId, setUserId] = useState('');
  const [modelId, setModelId] = useState('');
  const [query, setQuery] = useState(() => new URLSearchParams({ from: utcDate(-6), to: utcDate(1) }).toString());
  const [version, setVersion] = useState(0);
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setRows([]);
    void adminRequest<{ rows: UsageRow[] }>(`/usage?${query}`, { signal: controller.signal })
      .then(data => setRows(data.rows)).catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, version]);
  return <section className="admin-card" aria-labelledby="admin-usage-title"><h2 id="admin-usage-title">每日用量</h2><p className="admin-hint">UTC 日期，包含起始日、不含结束日，最多 31 天。</p>
    <form className="admin-toolbar" onSubmit={e => { e.preventDefault(); const days = (Date.parse(to) - Date.parse(from)) / 86400000; if (!Number.isFinite(days) || days <= 0 || days > 31) { setError('请选择 1 至 31 天的有效日期区间。'); return; } setQuery(new URLSearchParams({ from, to, ...(userId.trim() ? { userId: userId.trim() } : {}), ...(modelId.trim() ? { modelId: modelId.trim() } : {}) }).toString()); setVersion(v => v + 1); }}>
      <label>起始日<input type="date" required value={from} onChange={e => setFrom(e.target.value)} /></label><label>结束日（不含）<input type="date" required value={to} onChange={e => setTo(e.target.value)} /></label><label>用户 ID（可选）<input value={userId} onChange={e => setUserId(e.target.value)} /></label><label>模型 ID（可选）<input value={modelId} onChange={e => setModelId(e.target.value)} /></label><button className="btn-primary" disabled={loading}>查询</button>
    </form>{error && <p role="alert" className="admin-error">{error}</p>}{loading && <p role="status">加载用量中…</p>}
    {!loading && !error && (rows.length === 0 ? <p>该区间暂无用量</p> : <div className="admin-table-wrap"><table className="data-table"><thead><tr><th>UTC 日期</th><th>用户</th><th>模型</th><th>Tokens</th></tr></thead><tbody>{rows.map(row => <tr key={`${row.date}/${row.userId}/${row.modelId}`}><td>{row.date.slice(0, 10)}</td><td>{row.userId}</td><td>{row.modelId}</td><td>{row.tokens}</td></tr>)}</tbody></table></div>)}
  </section>;
}
