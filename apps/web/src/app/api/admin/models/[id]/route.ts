import { prisma, type Prisma } from '@aichat/db';
import { z } from 'zod';
import { requireAdmin, json, error, readBody } from '@/lib/admin';
import { registryCapabilities, registryModel, registrySelect } from '@/lib/admin-models';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const patchSchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  available: z.boolean().optional(),
}).strict().refine(body => Object.keys(body).length > 0);

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin(req);
  if (guard.response) return guard.response;
  const parsed = patchSchema.safeParse(await readBody(req));
  if (!parsed.success) return error('INVALID_PARAMS', 400);
  const { id } = await context.params;
  return prisma.$transaction(async tx => {
    // Keep concurrent label/availability changes from overwriting other capabilities.
    await tx.$queryRaw`SELECT id FROM "ModelRegistry" WHERE id = ${id} FOR UPDATE`;
    const model = await tx.modelRegistry.findUnique({ where: { id }, select: registrySelect });
    if (!model) return error('NOT_FOUND', 404);
    const updated = await tx.modelRegistry.update({
      where: { id },
      data: { capabilities: { ...registryCapabilities(model.capabilities), ...parsed.data } as Prisma.InputJsonObject },
      select: registrySelect,
    });
    return json({ model: registryModel(updated) });
  });
}
