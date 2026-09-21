import { headers } from 'next/headers';
import { prisma } from '@aichat/db';
import { auth } from './auth';
import { isSameOrigin } from './same-origin';

export const userSelect = { id: true, email: true, role: true, disabled: true } as const;
export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', Vary: 'Cookie' } });
}
export function error(code: string, status: number): Response { return json({ error: code }, status); }
export async function requireAdmin(req?: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return { response: error('UNAUTHORIZED', 401) } as const;
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: userSelect });
  if (!user || user.disabled || user.role !== 'ADMIN' || session.user.role !== 'ADMIN') {
    return { response: error('FORBIDDEN', 403) } as const;
  }
  if (req && !isSameOrigin(req)) return { response: error('FORBIDDEN', 403) } as const;
  return { user } as const;
}
export async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch { return null; }
}
