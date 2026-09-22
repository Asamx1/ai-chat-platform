import { prisma } from '@aichat/db';
import { requireAdmin, json } from '@/lib/admin';
import { registryModel, registrySelect } from '@/lib/admin-models';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;
  const models = await prisma.modelRegistry.findMany({
    select: registrySelect, orderBy: [{ modelKey: 'asc' }, { id: 'asc' }],
  });
  return json({ models: models.map(registryModel) });
}
