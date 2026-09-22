'use client';

import { useEffect, useState } from 'react';
import { adminRequest } from './api';
interface RegistryModel { id: string; modelKey: string; label: string; kind: string; provider: string; available: boolean }

function ModelRow({ model, onSaved }: { model: RegistryModel; onSaved: (model: RegistryModel) => void }) {
  const [label, setLabel] = useState(model.label);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function save(patch: { label?: string; available?: boolean }) {
    setSaving(true); setError('');
    try {
      const data = await adminRequest<{ model: RegistryModel }>(`/models/${encodeURIComponent(model.id)}`, {
        method: 'PATCH', body: JSON.stringify(patch),
      });
      onSaved(data.model);
      if (patch.label !== undefined) setLabel(data.model.label);
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); }
    finally { setSaving(false); }
  }
  return <tr>
    <td>{model.modelKey}<small>{model.id}</small></td>
    <td><form className="admin-toolbar" onSubmit={e => { e.preventDefault(); void save({ label: label.trim() }); }}>
      <input aria-label={`${model.modelKey} 标签`} required maxLength={200} value={label} disabled={saving} onChange={e => setLabel(e.target.value)} />
      <button className="btn-ghost" disabled={saving || !label.trim() || label.trim() === model.label}>保存标签</button>
    </form>{error && <p role="alert" className="settings-error">{error}</p>}{saving && <span role="status">保存中…</span>}</td>
    <td>{model.kind}</td><td>{model.provider}</td>
    <td><input type="checkbox" role="switch" aria-label={`启用 ${model.modelKey} (${model.provider})`} checked={model.available} disabled={saving} onChange={e => void save({ available: e.target.checked })} /></td>
  </tr>;
}

export default function ModelRegistryPanel() {
  const [models, setModels] = useState<RegistryModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void adminRequest<{ models: RegistryModel[] }>('/models', { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setModels(data.models); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [version]);
  return <section className="settings-card admin-card" aria-labelledby="admin-models-title">
    <div className="settings-card-title"><h2 id="admin-models-title">模型注册表</h2><button className="btn-ghost" disabled={loading} onClick={() => setVersion(v => v + 1)}>刷新</button></div>
    <p className="settings-hint">开关控制注册项启用状态；实际可用性仍受提供方、API Key 和配额限制。</p>
    {error && <p role="alert" className="settings-error">{error}</p>}
    {loading && <p role="status">加载模型中…</p>}
    {!loading && !error && (models.length === 0 ? <p>暂无模型</p> : <div className="admin-table-wrap"><table className="data-table">
      <thead><tr><th>模型 Key</th><th>标签</th><th>类型</th><th>提供方</th><th>启用</th></tr></thead>
      <tbody>{models.map(model => <ModelRow key={`${version}/${model.id}`} model={model} onSaved={updated => setModels(rows => rows.map(row => row.id === updated.id ? updated : row))} />)}</tbody>
    </table></div>)}
  </section>;
}
