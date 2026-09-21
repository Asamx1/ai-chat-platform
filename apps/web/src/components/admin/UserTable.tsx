'use client';

import { useEffect, useState } from 'react';
import { adminRequest, type AdminUser } from './api';

export default function UserTable({ currentUserId, onSelect }: { currentUserId: string; onSelect: (user: AdminUser) => void }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState<{ user: AdminUser; patch: Partial<Pick<AdminUser, 'role' | 'disabled'>> } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    const params = new URLSearchParams({ q: query, limit: '20', ...(cursor ? { cursor } : {}) });
    void adminRequest<{ users: AdminUser[]; nextCursor: string | null }>(`/users?${params}`, { signal: controller.signal })
      .then(data => { setUsers(data.users); setNextCursor(data.nextCursor); })
      .catch(e => { if (!controller.signal.aborted) setError(String(e.message)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, cursor, version]);

  async function save() {
    if (!pending) return;
    setSaving(true); setError(''); setFeedback('');
    try {
      const { user } = await adminRequest<{ user: AdminUser }>(`/users/${encodeURIComponent(pending.user.id)}`, {
        method: 'PATCH', body: JSON.stringify(pending.patch),
      });
      setUsers(rows => rows.map(row => row.id === user.id ? user : row));
      setPending(null); setFeedback('用户已更新，目标用户的现有会话将失效。');
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); }
    finally { setSaving(false); }
  }

  return <section className="admin-card" aria-labelledby="admin-users-title">
    <h2 id="admin-users-title">用户管理</h2>
    <form className="admin-toolbar" onSubmit={e => { e.preventDefault(); setCursor(''); setQuery(q.trim()); setVersion(v => v + 1); }}>
      <label>搜索用户<input value={q} onChange={e => setQ(e.target.value)} /></label>
      <button className="btn-ghost" disabled={saving || loading}>搜索 / 刷新</button>
    </form>
    {error && <p role="alert" className="admin-error">{error}</p>}
    <p role="status">{loading ? '加载用户中…' : feedback}</p>
    {!loading && !error && users.length === 0 && <p>暂无用户</p>}
    {!loading && <div className="admin-table-wrap"><table className="data-table"><thead><tr><th>用户</th><th>角色</th><th>禁用</th><th>配额</th></tr></thead>
      <tbody>{users.map(user => <tr key={user.id}><td>{user.email}<small>{user.id}</small></td>
        <td><select aria-label={`${user.email} 角色`} value={user.role} disabled={saving || !!pending || user.id === currentUserId} onChange={e => setPending({ user, patch: { role: e.target.value as AdminUser['role'] } })}><option value="USER">USER</option><option value="ADMIN">ADMIN</option></select></td>
        <td><input type="checkbox" role="switch" aria-label={`禁用 ${user.email}`} checked={user.disabled} disabled={saving || !!pending || user.id === currentUserId} onChange={e => setPending({ user, patch: { disabled: e.target.checked } })} /></td>
        <td><button className="btn-ghost" onClick={() => onSelect(user)}>编辑限额</button></td></tr>)}</tbody></table></div>}
    <div className="admin-toolbar"><button className="btn-ghost" disabled={!cursor || loading || saving || !!pending} onClick={() => setCursor('')}>首页</button><button className="btn-ghost" disabled={!nextCursor || loading || saving || !!pending} onClick={() => setCursor(nextCursor!)}>下一页</button></div>
    {pending && <div className="settings-confirm" role="alertdialog" aria-modal="false" aria-labelledby="admin-confirm-title">
      <h3 id="admin-confirm-title">确认修改 {pending.user.email}</h3>
      <p>{pending.patch.role ? `角色改为 ${pending.patch.role}` : pending.patch.disabled ? '禁用该用户' : '启用该用户'}。该用户需要重新登录。</p>
      <div className="admin-toolbar"><button className="btn-primary" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '确认修改'}</button><button className="btn-ghost" disabled={saving} onClick={() => setPending(null)}>取消</button></div>
    </div>}
  </section>;
}
