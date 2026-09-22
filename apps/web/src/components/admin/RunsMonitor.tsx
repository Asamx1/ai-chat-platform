'use client';

import { useEffect, useState } from 'react';
import { adminRequest } from './api';
interface Run { id: string; type: string; status: string; durationMs: number; createdAt: string; error: string | null }
function relativeTime(date: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(date)) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}
const badgeClass: Record<string, string> = {
  RUNNING: 'is-running', COMPLETE: 'is-ok', FAILED: 'is-failed', PENDING: 'is-empty', CANCELLED: 'is-empty',
};
export default function RunsMonitor() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void adminRequest<{ runs: Run[] }>('/runs', { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) { setRuns(data.runs); setNow(Date.now()); } })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [version]);
  useEffect(() => {
    const timer = setInterval(() => setVersion(v => v + 1), 30000);
    return () => clearInterval(timer);
  }, []);
  return <section className="settings-card admin-card" aria-labelledby="admin-runs-title">
    <div className="settings-card-title"><h2 id="admin-runs-title">Orchestration Run 监控</h2><button className="btn-ghost" disabled={loading} onClick={() => setVersion(v => v + 1)}>刷新</button></div>
    <p className="settings-hint">最近 50 条，每 30 秒刷新。耗时从创建时起计算，包含等待时间。</p>
    {error && <p role="alert" className="settings-error">{error}</p>}
    {loading && <p role="status">刷新运行记录中…</p>}
    {!loading && !error && runs.length === 0 && <p>暂无运行记录</p>}
    {runs.length > 0 && <div className="admin-table-wrap"><table className="data-table">
      <thead><tr><th>Run ID / 错误详情</th><th>类型</th><th>状态</th><th>耗时</th><th>创建时间</th></tr></thead>
      <tbody>{runs.map(run => <tr key={run.id}>
        <td><details><summary>{run.id}</summary><pre className="admin-run-error">{run.error ?? '无错误记录'}</pre></details></td>
        <td>{run.type}</td><td><span className={`settings-badge ${badgeClass[run.status] ?? 'is-empty'}`}>{run.status}</span></td>
        <td>{(run.durationMs / 1000).toFixed(1)} 秒</td>
        <td><time dateTime={run.createdAt} title={new Date(run.createdAt).toLocaleString()}>{relativeTime(run.createdAt, now)}</time></td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
