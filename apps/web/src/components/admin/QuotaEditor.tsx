'use client';

import { useEffect, useState } from 'react';
import { adminRequest, type AdminUser } from './api';

interface Quota { modelId: string; dailyLimit: number | null; effectiveLimit: number; source: string }
export default function QuotaEditor({ user }: { user: AdminUser | null }) {
  const [items, setItems] = useState<Quota[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    setLoading(true); setError('');
    void adminRequest<{ items: Quota[] }>(`/quotas?${new URLSearchParams({ userId: user.id })}`, { signal: controller.signal })
      .then(data => { setItems(data.items); setDrafts(Object.fromEntries(data.items.map(q => [q.modelId, String(q.dailyLimit ?? q.effectiveLimit)]))); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [user, version]);
  async function save(modelId: string, reset: boolean) {
    if (!user) return;
    const draft = drafts[modelId] ?? '';
    const value = Number(draft);
    if (!reset && (!/^\d+$/.test(draft) || !Number.isInteger(value) || value > 2147483647)) { setError('限额须为 0 至 2147483647 的整数。'); return; }
    setSaving(modelId); setError(''); setFeedback('');
    try {
      await adminRequest(`/quotas/${encodeURIComponent(user.id)}/${encodeURIComponent(modelId)}`, { method: reset ? 'DELETE' : 'PUT', ...(!reset ? { body: JSON.stringify({ dailyLimit: value }) } : {}) });
      setFeedback(reset ? '已恢复默认限额。' : '限额已保存。'); setVersion(v => v + 1);
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); }
    finally { setSaving(''); }
  }
  return <section className="admin-card" aria-labelledby="admin-quota-title"><h2 id="admin-quota-title">模型每日限额{user ? ` · ${user.email}` : ''}</h2>
    <p className="admin-hint">从用户表选择用户。0 禁止云调用；恢复默认会删除覆盖值。</p>
    {error && <p role="alert" className="admin-error">{error}</p>}<p role="status">{loading ? '加载限额中…' : feedback}</p>
    {user && <button className="btn-ghost" disabled={loading || !!saving} onClick={() => setVersion(v => v + 1)}>刷新限额</button>}
    {user && !loading && !error && items.length === 0 && <p>暂无模型</p>}
    {user && !loading && <div className="admin-table-wrap"><table className="data-table"><thead><tr><th>模型</th><th>生效限额 / 来源</th><th>每日 token 限额</th><th>操作</th></tr></thead><tbody>{items.map(item => <tr key={item.modelId}><td>{item.modelId}</td><td>{item.effectiveLimit} / {item.source}</td><td><input aria-label={`${item.modelId} 每日限额`} type="number" min="0" max="2147483647" step="1" value={drafts[item.modelId] ?? ''} disabled={!!saving} onChange={e => setDrafts(d => ({ ...d, [item.modelId]: e.target.value }))} /></td><td><div className="admin-toolbar"><button className="btn-primary" disabled={!!saving} onClick={() => void save(item.modelId, false)}>保存</button><button className="btn-ghost" disabled={!!saving} onClick={() => void save(item.modelId, true)}>恢复默认</button></div></td></tr>)}</tbody></table></div>}
  </section>;
}
