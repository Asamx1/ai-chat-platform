import React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { prisma } from '@aichat/db';
import { auth } from '@/lib/auth';
import PlaygroundForm from '@/components/kb/PlaygroundForm';

export const runtime = 'nodejs';

const SWITCHES = ['RAG_HYBRID', 'RAG_MMR', 'RAG_SMALL2BIG', 'RAG_RERANK', 'RAG_REWRITE'] as const;
const STRATEGIES = ['structure', 'recursive', 'fixed'] as const;

/**
 * 检索 Playground。[id] 是 KnowledgeBase id（与 API 路由一致）；
 * RAG_* 开关为服务端进程环境只读展示（默认开启，'0' 关闭）。
 */
export default async function KbPlaygroundPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) redirect('/login');
  const { id } = await params;

  const rows = await prisma.$queryRaw<{ id: string; name: string }[]>`
    SELECT id, name FROM "KnowledgeBase" WHERE id = ${id} AND "userId" = ${session.user!.id}`;
  const kb = rows[0];
  if (!kb) {
    return (
      <div className="settings-page">
        <a className="settings-back" href="/kb">← 返回知识库</a>
        <header className="settings-header">
          <h1>检索 Playground</h1>
          <p>知识库不存在或无权访问</p>
        </header>
      </div>
    );
  }

  const docStrategies = await prisma.$queryRaw<{ chunkStrategy: string }[]>`
    SELECT DISTINCT "chunkStrategy" FROM "Document" WHERE "kbId" = ${id} ORDER BY "chunkStrategy"`;
  const switches = Object.fromEntries(SWITCHES.map(name => [name, process.env[name] !== '0']));

  return (
    <div className="settings-page">
      <a className="settings-back" href="/kb">← 返回知识库</a>
      <header className="settings-header">
        <h1>检索 Playground</h1>
        <p>{kb.name}</p>
      </header>
      <PlaygroundForm
        kbId={kb.id}
        strategies={[...new Set([...docStrategies.map(row => row.chunkStrategy), ...STRATEGIES])]}
        switches={switches}
      />
    </div>
  );
}
