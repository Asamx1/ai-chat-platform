import { prisma } from '@aichat/db';
import { requireAdmin, json, error, readBody, userSelect } from '@/lib/admin';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin(req);
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const body = await readBody(req);
  if (!body || !Object.keys(body).length || Object.keys(body).some(k => !['role', 'disabled'].includes(k)) ||
    ('disabled' in body && typeof body.disabled !== 'boolean') ||
    ('role' in body && body.role !== 'ADMIN' && body.role !== 'USER')) return error('INVALID_PARAMS', 400);
  const disabled = body.disabled as boolean | undefined;
  const role = body.role as 'ADMIN' | 'USER' | undefined;
  return prisma.$transaction(async tx => {
    // Serialize all role mutations, including concurrent promotions/demotions, then lock ADMIN rows.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(72819201)`;
    await tx.$queryRaw`SELECT id FROM "User" WHERE role = 'ADMIN' ORDER BY id FOR UPDATE`;
    const actor = await tx.user.findUnique({ where: { id: guard.user.id }, select: userSelect });
    if (!actor || actor.disabled || actor.role !== 'ADMIN') return error('FORBIDDEN', 403);
    const target = await tx.user.findUnique({ where: { id }, select: userSelect });
    if (!target) return error('NOT_FOUND', 404);
    if (id === actor.id && (disabled === true || role === 'USER')) return error('SELF_DEMOTION', 409);
    if (target.role === 'ADMIN' && !target.disabled && (disabled === true || role === 'USER')) {
      if (await tx.user.count({ where: { role: 'ADMIN', disabled: false } }) <= 1) return error('LAST_ADMIN', 409);
    }
    const user = await tx.user.update({ where: { id }, data: {
      ...(disabled !== undefined ? { disabled } : {}), ...(role !== undefined ? { role } : {}),
    }, select: userSelect });
    await tx.session.deleteMany({ where: { userId: id } });
    return json({ user });
  });
}
