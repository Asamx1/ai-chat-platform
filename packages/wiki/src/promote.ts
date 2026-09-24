import type { Prisma, PrismaClient, VaultEntityCandidate } from '@aichat/db';

export type PromotionDb = PrismaClient | Prisma.TransactionClient;
export interface PromotionCandidate {
  candidate: VaultEntityCandidate;
  distinctFamilies: number;
  relatedAssertions: number;
}
/** Shared filename rule; Unicode letters preserve Chinese concept names. */
export function pageSlug(name: string): string {
  const slug = name.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, '-').replace(/[^\p{L}\p{N}_-]/gu, '');
  if (!slug) throw new Error('EMPTY_PAGE_SLUG');
  return slug;
}
function families(value: unknown): number {
  return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0) : []).size;
}
export async function eligiblePromotions(vaultId: string, db: PromotionDb): Promise<PromotionCandidate[]> {
  const rows = await db.vaultEntityCandidate.findMany({ where: { vaultId, status: 'candidate', type: { not: 'Source' } }, orderBy: { id: 'asc' } });
  const result: PromotionCandidate[] = [];
  for (const candidate of rows) {
    const distinctFamilies = families(candidate.familyIdsJson);
    if (distinctFamilies < 2) continue;
    const relatedAssertions = await db.vaultAssertion.count({ where: { vaultId, status: { in: ['supported', 'candidate'] }, OR: [{ subjectId: candidate.id }, { objectId: candidate.id }] } });
    result.push({ candidate, distinctFamilies, relatedAssertions });
  }
  return result;
}
export async function promoteEntity(candidateId: string, vaultId: string, db: PromotionDb): Promise<{ pageId: string; releaseNote: string }> {
  if ('$transaction' in db) return db.$transaction(tx => promoteEntity(candidateId, vaultId, tx));
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wiki-publish:${vaultId}`}, 0))`;
  const row = await db.vaultEntityCandidate.findFirstOrThrow({ where: { id: candidateId, vaultId } });
  if (row.status === 'promoted') {
    if (!row.promotedPageId) throw new Error(`PROMOTED_PAGE_MISSING: ${row.id}`);
    return { pageId: row.promotedPageId, releaseNote: `${row.canonicalName}: already promoted` };
  }
  if (row.status !== 'candidate' || row.type === 'Source' || families(row.familyIdsJson) < 2) throw new Error(`PROMOTION_INELIGIBLE: ${candidateId}`);
  const pageId = pageSlug(row.canonicalName);
  const collision = await db.vaultEntityCandidate.findFirst({ where: { vaultId, promotedPageId: pageId, id: { not: row.id } } });
  if (collision) throw new Error(`PAGE_SLUG_COLLISION: ${pageId}`);
  await db.vaultEntityCandidate.update({ where: { id: row.id }, data: { status: 'promoted', promotedPageId: pageId } });
  await db.vaultAssertion.updateMany({ where: { vaultId, status: 'candidate', OR: [{ subjectId: row.id }, { objectId: row.id }], evidence: { some: { vaultId, stance: 'supports', source: { vaultId } } } }, data: { status: 'supported' } });
  return { pageId, releaseNote: `${row.canonicalName}: promoted (${families(row.familyIdsJson)} independent families)` };
}
