import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { prisma } from '@aichat/db';
import { auth } from '@/lib/auth';
import { answerStrict } from '../../../../../../packages/wiki/src/query';

export const runtime = 'nodejs';

const unavailable = () => NextResponse.json(
  { error: '知识问答暂不可用，请稍后手动重试。' }, { status: 503 },
);

export async function POST(req: Request) {
  let session;
  try {
    session = await auth.api.getSession({ headers: await headers() });
  } catch { return unavailable(); }
  if (!session?.user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });

  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: '请求必须是 JSON。' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      !('question' in body) || typeof body.question !== 'string' || !body.question.trim() ||
      ('vaultId' in body && (typeof body.vaultId !== 'string' || !body.vaultId.trim()))) {
    return NextResponse.json({ error: '请提供非空 question，vaultId 如提供也须为非空字符串。' }, { status: 400 });
  }

  try {
    // Each request carries only its own question; no conversation history is read.
    const result = await answerStrict(
      body.question.trim(),
      'vaultId' in body ? (body.vaultId as string).trim() : 'default',
      process.env.WIKI_VAULT_PATH || '/mnt/d/wiki-vault',
      prisma,
      { userId: session.user.id },
    );
    if (result.kind === 'unknown') {
      if (result.reason === 'RETRIEVAL_FAILED') return unavailable();
      return NextResponse.json({
        kind: result.reason === 'OUT_OF_SCOPE' ? 'out_of_scope' : 'no_evidence',
        answer: result.reason === 'OUT_OF_SCOPE' ? '该问题超出知识库范围。' : '知识库中没有足够证据回答该问题。',
        citations: [], inferredParts: [],
      });
    }
    return NextResponse.json(result);
  } catch { return unavailable(); }
}
