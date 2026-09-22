import React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { prisma } from '@aichat/db';
import { auth } from '@/lib/auth';
import ChunksView, { type ChunkRow } from '@/components/kb/ChunksView';

export const runtime = 'nodejs';

type DocRow = { id: string; name: string; chunkStrategy: string; chunkCount: number; status: string };

/**
 * 文档 chunk 预览（small-to-big 视图）。[id] 是 Document id：与 rechunk API 的语义一致，
 * 权限通过 Document → KnowledgeBase.userId 校验，参数化 SQL 兼容 §1 迁移前的 client。
 */
export default async function DocumentChunksPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) redirect('/login');
  const { id } = await params;

  const docs = await prisma.$queryRaw<DocRow[]>`
    SELECT d.id, d.name, d."chunkStrategy", d."chunkCount", d.status
    FROM "Document" d JOIN "KnowledgeBase" k ON k.id = d."kbId"
    WHERE d.id = ${id} AND k."userId" = ${session.user!.id}`;
  const doc = docs[0];
  if (!doc) {
    return (
      <div className="settings-page">
        <a className="settings-back" href="/kb">← 返回知识库</a>
        <header className="settings-header">
          <h1>Chunk 预览</h1>
          <p>文档不存在或无权访问</p>
        </header>
      </div>
    );
  }

  const rows = await prisma.$queryRaw<ChunkRow[]>`
    SELECT c.id, c."parentId", c."headingPath", c.kind, c.ordinal, c.start, c.end, c.text
    FROM "Chunk" c
    WHERE c."documentId" = ${id}
    ORDER BY c.ordinal, c.id`;

  return (
    <div className="settings-page">
      <a className="settings-back" href="/kb">← 返回知识库</a>
      <header className="settings-header">
        <h1>Chunk 预览</h1>
        <p>
          {doc.name} · 策略 {doc.chunkStrategy} · {doc.chunkCount} chunks · 状态 {doc.status}
        </p>
      </header>
      <section className="settings-card">
        <div className="settings-card-title">
          <h2>分块结构（small-to-big）</h2>
        </div>
        <ChunksView chunks={rows} />
      </section>
    </div>
  );
}
