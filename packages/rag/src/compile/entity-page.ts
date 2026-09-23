import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@aichat/db';
import type { CompileJobRow } from './compile-job';

export type PageEntity = { id: string; canonicalName: string; type: string; context: string; aliases: string[] };
export type PageEvidence = { documentId: string; chunkId: string; quote: string };
export type PageRelation = { predicate: string; subjectId: string; subjectName: string; objectId: string; objectName: string; evidence: PageEvidence[] };
export type PageFact = { claim: string; evidence: PageEvidence[] };
export const entityPageKey = (kbId: string, generationId: string, entityId: string) => `wiki/${kbId}/${generationId}/${entityId}.md`;
const citation = (e: PageEvidence) => `[原文引文：${e.quote}](source:${e.documentId}#${e.chunkId})`;
const link = (id: string, name: string) => `[[${id}|${name}]]`;

export function renderEntityPage(entity: PageEntity, relations: readonly PageRelation[], facts: readonly PageFact[]): string {
  const relationLines = relations.filter(r => r.evidence.length).map(r =>
    `- ${link(r.subjectId, r.subjectName)} ${r.predicate} ${link(r.objectId, r.objectName)} ${r.evidence.map(citation).join(' ')}`);
  const factLines = facts.filter(f => f.evidence.length).map(f => `- ${f.claim} ${f.evidence.map(citation).join(' ')}`);
  return `# ${entity.canonicalName}\n\n类型：${entity.type}\n\n上下文：${entity.context}\n\n别名：${entity.aliases.join('、')}\n\n## 关系\n\n${relationLines.join('\n')}\n\n## 关键事实\n\n${factLines.join('\n')}\n`;
}

export async function enqueueEntityPages(kbId: string, generationId: string, sourceVersionId: string): Promise<number> {
  const entities = await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT DISTINCT e.id FROM "Entity" e
    JOIN "EntityMention" m ON m."entityId"=e.id AND m."kbId"=e."kbId"
    WHERE e."kbId"=$1 AND m."generationId"=$2 ORDER BY e.id`, kbId, generationId);
  for (const entity of entities) {
    const key = createHash('sha256').update(`${kbId}:${generationId}:${entity.id}:ENTITY_PAGE:v1`).digest('hex');
    await prisma.$executeRawUnsafe(`INSERT INTO "CompileJob" (id,"kbId","sourceVersionId","generationId","artifactType",model,"promptVersion","schemaVersion",status,attempt,"maxAttempts","idempotencyKey","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,'ENTITY_PAGE','renderer',$6,'v1','PENDING',0,2,$5,clock_timestamp(),clock_timestamp())
      ON CONFLICT ("idempotencyKey") DO NOTHING`, randomUUID(), kbId, sourceVersionId, generationId, key, entity.id);
  }
  return entities.length;
}

export async function loadEntityPage(job: CompileJobRow): Promise<{ entity: PageEntity; relations: PageRelation[]; facts: PageFact[]; entityId: string }> {
  const [identity] = await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT e.id FROM "CompileJob" j JOIN "Entity" e ON e.id=j."promptVersion" AND e."kbId"=j."kbId"
    JOIN "EntityMention" m ON m."entityId"=e.id AND m."generationId"=j."generationId"
    WHERE j.id=$1 AND j."kbId"=$2 AND j."generationId"=$3 AND j."artifactType"='ENTITY_PAGE' LIMIT 1`, job.id, job.kbId, job.generationId);
  const entityId = identity?.id;
  if (!entityId) throw new Error('ENTITY_PAGE_SCOPE');
  const [row] = await prisma.$queryRawUnsafe<{ id: string; canonicalName: string; type: string; context: string }[]>(`SELECT id,"canonicalName",type,context FROM "Entity" WHERE id=$1 AND "kbId"=$2`, entityId, job.kbId);
  if (!row) throw new Error('ENTITY_PAGE_SCOPE');
  const aliases = await prisma.$queryRawUnsafe<{ alias: string }[]>(`SELECT alias FROM "EntityAlias" WHERE "entityId"=$1 ORDER BY alias`, entityId);
  const relationRows = await prisma.$queryRawUnsafe<{ id: string; predicate: string; subjectId: string; subjectName: string; objectId: string; objectName: string; documentId: string; chunkId: string; quote: string }[]>(`SELECT r.id,r.predicate,r."subjectId",s."canonicalName" AS "subjectName",r."objectId",o."canonicalName" AS "objectName",
    ev."documentId",ev."chunkId",ev."evidenceText" AS quote FROM "EntityRelation" r JOIN "Entity" s ON s.id=r."subjectId" JOIN "Entity" o ON o.id=r."objectId"
    JOIN "RelationEvidence" ev ON ev."relationId"=r.id JOIN "Chunk" c ON c.id=ev."chunkId" AND c."generationId"=r."generationId"
    JOIN "Document" d ON d.id=ev."documentId" AND d.kind='SOURCE' AND d."sourceVersionId"=ev."sourceVersionId"
    WHERE r."kbId"=$1 AND r."generationId"=$2 AND (r."subjectId"=$3 OR r."objectId"=$3) ORDER BY r.id,ev.id`, job.kbId, job.generationId, entityId);
  const relationMap = new Map<string, PageRelation>();
  for (const r of relationRows) {
    const entry = relationMap.get(r.id) ?? { predicate: r.predicate, subjectId: r.subjectId, subjectName: r.subjectName, objectId: r.objectId, objectName: r.objectName, evidence: [] };
    entry.evidence.push({ documentId: r.documentId, chunkId: r.chunkId, quote: r.quote }); relationMap.set(r.id, entry);
  }
  const factRows = await prisma.$queryRawUnsafe<{ claim: string; documentId: string; chunkId: string; quote: string }[]>(`SELECT f.claim,ev."documentId",ev."chunkId",ev."evidenceText" AS quote FROM "DerivedFact" f
    JOIN "EntityRelation" r ON r.id=f."relationId" AND r."generationId"=f."generationId"
    JOIN "RelationEvidence" ev ON ev."relationId"=r.id JOIN "Chunk" c ON c.id=ev."chunkId" AND c."generationId"=f."generationId"
    JOIN "Document" d ON d.id=ev."documentId" AND d.kind='SOURCE' AND d."sourceVersionId"=ev."sourceVersionId"
    WHERE f."kbId"=$1 AND f."generationId"=$2 AND (f."entityId"=$3 OR r."subjectId"=$3 OR r."objectId"=$3)
      AND f."evidenceJson"->>'status' IS DISTINCT FROM 'needs_verification' ORDER BY f.id,ev.id`, job.kbId, job.generationId, entityId);
  const factMap = new Map<string, PageFact>();
  for (const f of factRows) { const entry = factMap.get(f.claim) ?? { claim: f.claim, evidence: [] }; entry.evidence.push({ documentId: f.documentId, chunkId: f.chunkId, quote: f.quote }); factMap.set(f.claim, entry); }
  return { entity: { ...row, aliases: aliases.map(a => a.alias) }, relations: [...relationMap.values()], facts: [...factMap.values()], entityId };
}
