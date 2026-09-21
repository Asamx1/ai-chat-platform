'use client';

import { useRef, useState } from 'react';

const MAX_SIZE = 20 * 1024 * 1024; // 20MB 前端预检
const ALLOWED_EXT = ['pdf', 'md', 'txt'];

/** 上传失败错误文案（PRD 口径） */
function uploadErrorText(status: number, code?: string): string {
  if (status === 413 || code === 'FILE_TOO_LARGE') return '文件超过 20MB 限制，请拆分后再上传';
  if (status === 415 || code === 'UNSUPPORTED_FORMAT') return '仅支持 PDF / Markdown / 纯文本文件';
  if (status === 400) return '请求无效：请提供已有知识库 ID 或新库名称';
  if (status === 401) return '登录已过期，请重新登录后再上传';
  if (status === 404) return '目标知识库不存在';
  return '上传失败，请稍后重试';
}

/**
 * 文件上传：PDF/MD/TXT，≤20MB 前端预检；multipart 单 file。
 * POST /api/kb → 202 {kbId,document}。
 */
export default function KbUpload({ onUploaded }: { onUploaded: () => void }) {
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const pick = (f: File | null) => {
    setError(null);
    setDone(null);
    if (!f) {
      setFile(null);
      return;
    }
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (!ALLOWED_EXT.includes(ext)) {
      setError('仅支持 PDF / Markdown / 纯文本文件');
      setFile(null);
      return;
    }
    if (f.size > MAX_SIZE) {
      setError('文件超过 20MB 限制，请拆分后再上传');
      setFile(null);
      return;
    }
    setFile(f);
  };

  const submit = async () => {
    if (!file || uploading) return;
    const kbName = name.trim();
    if (!kbName) {
      setError('请为新知识库输入名称');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('name', kbName);
      const res = await fetch('/api/kb', {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      if (res.status === 202 || res.ok) {
        setDone(`已上传「${file.name}」，解析中…`);
        setName('');
        setFile(null);
        if (inputRef.current) inputRef.current.value = '';
        onUploaded();
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(uploadErrorText(res.status, body?.error));
    } catch {
      setError('上传失败，请检查网络后重试');
    } finally {
      setUploading(false);
    }
  };

  return (
    <form
      className="kb-upload"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="login-field">
        <label htmlFor="kb-new-name">知识库名称</label>
        <input
          id="kb-new-name"
          className="login-input"
          type="text"
          placeholder="例如：产品手册"
          value={name}
          maxLength={64}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="login-field">
        <label htmlFor="kb-file">文档文件（PDF / MD / TXT，≤20MB）</label>
        <input
          id="kb-file"
          ref={inputRef}
          className="kb-file-input"
          type="file"
          accept=".pdf,.md,.txt,application/pdf,text/markdown,text/plain"
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
        />
        {file && <small className="settings-hint">{file.name}（{(file.size / 1024 / 1024).toFixed(2)}MB）</small>}
      </div>
      <div className="settings-actions">
        <button type="submit" className={`btn-primary${uploading ? ' is-loading' : ''}`} disabled={uploading || !file}>
          {uploading ? '上传中…' : '上传并解析'}
        </button>
      </div>
      {done && <div className="kb-done">{done}</div>}
      {error && <div className="settings-error">{error}</div>}
    </form>
  );
}
