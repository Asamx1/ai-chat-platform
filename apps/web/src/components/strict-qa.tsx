'use client';

import React, { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import type { Citation, StrictAnswer } from '../../../../packages/wiki/src/query';

type Answer = Exclude<StrictAnswer, { kind: 'unknown' }> | {
  kind: 'no_evidence' | 'out_of_scope'; answer: string; citations: Citation[]; inferredParts: [];
};

const badges = {
  sourced: { label: '有据回答', color: 'border-green-800 bg-green-950 text-green-300' },
  inferred: { label: '推导回答', color: 'border-purple-800 bg-purple-950 text-[#A855F7]' },
  mixed: { label: '证据与推导', color: 'border-blue-800 bg-blue-950 text-blue-300' },
  no_evidence: { label: '证据不足', color: 'border-amber-600/50 bg-amber-950/30 text-amber-300' },
  out_of_scope: { label: '超出范围', color: 'border-zinc-700 bg-zinc-900 text-zinc-300' },
};

function locatorText(locator: Citation['locator']) {
  switch (locator.kind) {
    case 'page': return `第 ${locator.page} 页`;
    case 'section': return `章节：${locator.section}`;
    case 'offset': return `字符位置：${locator.start}–${locator.end}`;
    case 'time': return `时间：${locator.startSec}–${locator.endSec} 秒`;
  }
}

function excerpt(quote: string) {
  const chars = Array.from(quote);
  return chars.length > 120 ? `${chars.slice(0, 119).join('')}…` : quote;
}

function Premises({ ids }: { ids: string[] }) {
  return (
    <details className="mt-3 text-sm text-[#A855F7]">
      <summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-[#A855F7]">推导自 {ids.length} 条前提</summary>
      <ul className="mt-2 space-y-1 break-all pl-4 text-zinc-400">
        {ids.map((id, index) => <li key={`${id}-${index}`}>{id}</li>)}
      </ul>
    </details>
  );
}

export default function StrictQa() {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const pending = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!question.trim() || pending.current) return;
    pending.current = true;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch('/api/strict-qa', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question.trim() }),
      });
      if (!response.ok) {
        throw new Error(response.status === 401 ? '登录已失效，请重新登录。' :
          response.status === 503 ? '知识问答暂不可用，请稍后手动重试。' : '提问失败，请稍后手动重试。');
      }
      setResult(await response.json() as Answer);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '网络异常，请稍后手动重试。');
    } finally {
      pending.current = false;
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0b] px-5 py-8 text-zinc-100 sm:px-8">
      <div className="mx-auto max-w-3xl">
        <nav aria-label="知识问答导航" className="mb-12 flex gap-5 text-sm text-zinc-400">
          <Link href="/" className="hover:text-[#A855F7]">返回聊天</Link>
          <Link href="/kb" className="hover:text-[#A855F7]">知识库</Link>
        </nav>
        <header className="mb-8">
          <p className="mb-3 text-xs tracking-widest text-[#A855F7]">严格知识问答</p>
          <h1 className="text-3xl font-semibold">让每个回答有据可查</h1>
          <p id="qa-help" className="mt-4 text-sm leading-6 text-zinc-400">仅依据知识库证据回答，明确区分原文与推导。每次提问独立，不保留多轮上下文。</p>
        </header>
        <form onSubmit={submit} className="mb-8">
          <label htmlFor="qa-question" className="mb-2 block text-sm">你的问题</label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input id="qa-question" value={question} onChange={event => setQuestion(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}
              aria-describedby="qa-help" placeholder="输入想从知识库了解的问题…" required disabled={loading}
              className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-base outline-none focus:border-[#A855F7] focus:ring-1 focus:ring-[#A855F7] disabled:opacity-60" />
            <button type="submit" disabled={loading || !question.trim()}
              className="rounded-lg bg-[#A855F7] px-6 py-3 font-medium text-black focus-visible:outline focus-visible:outline-offset-4 focus-visible:outline-[#A855F7] disabled:cursor-not-allowed disabled:opacity-50">
              {loading ? '查询中…' : '提问'}
            </button>
          </div>
        </form>
        {error && <div role="alert" className="mb-6 rounded-lg border border-red-900 bg-red-950/30 p-4 text-sm text-red-300">{error} <Link href="/login" className="underline">前往登录</Link></div>}
        <section aria-label="问答结果" aria-live="polite" aria-busy={loading}>
          {loading && <p role="status" className="text-sm text-zinc-400">正在检索证据并生成回答…</p>}
          {result && <article className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 sm:p-6">
            <span className={`inline-flex rounded-full border px-3 py-1 text-xs ${badges[result.kind].color}`}>{badges[result.kind].label} · {result.kind}</span>
            <p className="mt-5 whitespace-pre-wrap break-words leading-7">{result.answer}</p>
            {result.inferredParts.length > 0 && <section aria-label="推导部分" className="mt-6 border-t border-zinc-800 pt-5">
              <h2 className="text-sm font-medium text-[#A855F7]">推导部分</h2>
              {result.inferredParts.map((part, index) => <div key={index} className="mt-4">
                <p className="whitespace-pre-wrap break-words text-sm leading-6 text-zinc-300">{part.text}</p>
                <Premises ids={part.premiseAssertionIds} />
              </div>)}
            </section>}
            {result.citations.length > 0 && <details className="mt-6 border-t border-zinc-800 pt-5">
              <summary className="cursor-pointer text-sm text-zinc-300">引用依据 · {result.citations.length} 条</summary>
              <ol className="mt-4 space-y-4">
                {result.citations.map((citation, index) => <li key={`${citation.assertionId}-${index}`} className="cite-card rounded-lg border border-zinc-800 p-4">
                  <h3 className="break-words text-sm font-medium">{citation.sourceTitle}</h3>
                  <p className="mt-1 break-words text-xs text-zinc-400">{locatorText(citation.locator)}</p>
                  <blockquote className="mt-3 whitespace-pre-wrap break-words border-l-2 border-zinc-700 pl-3 text-sm leading-6 text-zinc-300">{excerpt(citation.quote)}</blockquote>
                  {citation.origin === 'inferred' && <Premises ids={citation.premiseAssertionIds ?? citation.derivedFrom ?? []} />}
                </li>)}
              </ol>
            </details>}
          </article>}
        </section>
      </div>
    </div>
  );
}
