import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { prisma } from '@aichat/db';
import { encrypt, decrypt, maskKey } from '@aichat/crypto';
import { auth } from '@/lib/auth';

export const runtime = 'nodejs';

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  const rows = await prisma.apiKey.findMany({ where: { userId: session.user.id } });
  return NextResponse.json({
    keys: rows.map((row) => ({
      provider: row.providerId,
      maskedKey: maskKey(decrypt(row.ciphertext)),
      verified: row.verified,
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
}

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'KEY_MALFORMED' }, { status: 400 });
  }
  if (
    typeof body !== 'object' || body === null ||
    !('provider' in body) || body.provider !== 'deepseek' ||
    !('apiKey' in body) || typeof body.apiKey !== 'string' ||
    !/^sk-[A-Za-z0-9]{16,}$/.test(body.apiKey)
  ) return NextResponse.json({ error: 'KEY_MALFORMED' }, { status: 400 });

  try {
    const response = await fetch('https://api.deepseek.com/v1/models', {
      headers: { authorization: `Bearer ${body.apiKey}` },
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
      cache: 'no-store',
    });
    await response.body?.cancel();
    if (response.status === 401) {
      return NextResponse.json({ error: 'KEY_INVALID' }, { status: 401 });
    }
    if (response.status !== 200) {
      return NextResponse.json({ error: 'PROVIDER_UNREACHABLE' }, { status: 502 });
    }
  } catch {
    return NextResponse.json({ error: 'PROVIDER_UNREACHABLE' }, { status: 502 });
  }

  const ciphertext = encrypt(body.apiKey);
  await prisma.apiKey.upsert({
    where: { userId_providerId: { userId: session.user.id, providerId: 'deepseek' } },
    create: { userId: session.user.id, providerId: 'deepseek', ciphertext, verified: true },
    update: { ciphertext, verified: true },
  });
  return NextResponse.json({ provider: 'deepseek', maskedKey: maskKey(body.apiKey), verified: true });
}

export async function DELETE(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  const provider = new URL(req.url).searchParams.get('provider');
  if (provider !== 'deepseek') return NextResponse.json({ error: 'KEY_MALFORMED' }, { status: 400 });
  const result = await prisma.apiKey.deleteMany({
    where: { userId: session.user.id, providerId: provider },
  });
  return result.count ? new NextResponse(null, { status: 204 })
    : NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
}
