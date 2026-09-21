'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import KbList from './KbList';
import KbUpload from './KbUpload';
import { kbBusy, type KnowledgeBase } from './types';

/**
 * /kb 页面主体：上传 + 列表；存在解析中的知识库时每 3s 轮询刷新状态，全部终态后停止。
 */
export default function KbPage() {
  const [items, setItems] = useState<KnowledgeBase[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/kb?limit=100', { credentials: 'include' });
      if (!res.ok) {
        setError(res.status === 401 ? '登录已过期，请重新登录' : '知识库列表加载失败');
        return false;
      }
      const data = (await res.json()) as { items?: KnowledgeBase[] };
      setItems(data.items ?? []);
      setError(null);
      return true;
    } catch {
      setError('网络异常，列表加载失败');
      return false;
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 有解析中的条目 → 3s 轮询；全部终态停止
  useEffect(() => {
    if (!loaded || !items.some(kbBusy)) return;
    timerRef.current = setTimeout(() => void refresh(), 3000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [loaded, items, refresh]);

  const handleDeleted = useCallback((id: string) => {
    setItems((prev) => prev.filter((kb) => kb.id !== id));
  }, []);

  return (
    <div className="settings-page">
      <a className="settings-back" href="/">
        ← 返回聊天
      </a>
      <header className="settings-header">
        <h1>知识库</h1>
        <p>上传文档构建 RAG 知识库，并在会话中挂载引用</p>
      </header>

      <section className="settings-card">
        <div className="settings-card-title">
          <h2>上传文档</h2>
        </div>
        <KbUpload onUploaded={() => void refresh()} />
      </section>

      <section className="settings-card">
        <div className="settings-card-title">
          <h2>我的知识库</h2>
        </div>
        {error && <div className="settings-error">{error}</div>}
        <KbList items={items} onDeleted={handleDeleted} />
      </section>

      <footer className="settings-note">
        支持 PDF / Markdown / 纯文本，单文件不超过 20MB；解析完成后即可在会话中挂载。
      </footer>
    </div>
  );
}
