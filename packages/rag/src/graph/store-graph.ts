import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@aichat/db';
import { matchEntity, validateExtraction } from './extract';
import type { EntityCandidate, Extraction } from './extract';
import { normalizeName } from './ontology';
import type { GraphSql, Ontology } from './ontology';

export interface GraphDatabase extends GraphSql {
  $transaction<T>(run: (tx: GraphSql) => Promise<T>): Promise<T>;
}
export type GraphSource = { kbId: string; generationId: string; documentId: string; sourceVersionId: string; chunkId: string; text: string };
export type GraphLease = { id: string; attempt: number; leaseOwner: string };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export async function recallEntities(db: GraphSql, kbId: string, names: readonly string[]): Promise<EntityCandidate[]> {
  return db.$queryRawUnsafe<EntityCandidate[]>(`SELECT DISTINCT e.id,e.type,e.context FROM "Entity" e JOIN "EntityAlias" a ON a."entityId"=e.id WHERE e."kbId"=$1 AND a.normalized=ANY($2::text[]) ORDER BY e.id`, kbId, names.map(normalizeName));
}
export async function storeGraph(source: GraphSource, extraction: Extraction, schema: Ontology, db: GraphDatabase = prisma, lease?: GraphLease): Promise<void> {
  const checked = validateExtraction(extraction, source.text, schema);
  if (checked.rejected.length) throw new Error('GRAPH_INVALID_EXTRACTION');
  await db.$transaction(async tx => {
    await tx.$queryRawUnsafe(`SELECT id FROM "KnowledgeBase" WHERE id=$1 FOR UPDATE`, source.kbId);
    if (lease) {
      const valid = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "CompileJob" WHERE id=$1 AND attempt=$2 AND "leaseOwner"=$3 AND status='RUNNING' AND "leaseExpiresAt">clock_timestamp() FOR UPDATE`, lease.id, lease.attempt, lease.leaseOwner);
      if (!valid.length) throw new Error('COMPILE_LEASE_LOST');
    }
    const chunks = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT c.id FROM "Chunk" c JOIN "Document" d ON d.id=c."documentId" JOIN "SourceVersion" v ON v.id=$5
      JOIN "IndexGeneration" g ON g.id=c."generationId"
      WHERE c.id=$1 AND c."kbId"=$2 AND c."generationId"=$3 AND c."documentId"=$4 AND c.text=$6
      AND d."kbId"=$2 AND d.kind='SOURCE' AND d."sourceVersionId"=v.id AND v."kbId"=$2 AND v."documentId"=d.id AND g."kbId"=$2 FOR SHARE OF c,d,v,g`,
    source.chunkId, source.kbId, source.generationId, source.documentId, source.sourceVersionId, source.text);
    if (!chunks.length) throw new Error('GRAPH_SOURCE_SCOPE');
    const previous = await tx.$queryRawUnsafe<(EntityCandidate & { start: number; canonicalName: string })[]>(`SELECT e.id,e.type,e.context,e."canonicalName",m.start FROM "EntityMention" m JOIN "Entity" e ON e.id=m."entityId" WHERE m."kbId"=$1 AND m."generationId"=$2 AND m."chunkId"=$3`, source.kbId, source.generationId, source.chunkId);
    await tx.$executeRawUnsafe(`DELETE FROM "EntityMention" WHERE "kbId"=$1 AND "generationId"=$2 AND "chunkId"=$3`, source.kbId, source.generationId, source.chunkId);
    await tx.$executeRawUnsafe(`DELETE FROM "RelationEvidence" e USING "EntityRelation" r WHERE e."relationId"=r.id AND r."kbId"=$1 AND r."generationId"=$2 AND e."chunkId"=$3`, source.kbId, source.generationId, source.chunkId);
    const ids = new Map<string, string>();
    for (const entity of checked.entities) {
      const names = [...new Set([entity.name, ...entity.aliases])];
      const candidates = await recallEntities(tx, source.kbId, names);
      const match = previous.find(e => e.start === entity.start && e.type === entity.type && e.context === entity.context && e.canonicalName === entity.name) ?? matchEntity(entity, candidates); const id = match?.id ?? randomUUID(); ids.set(entity.key, id);
      if (!match) await tx.$executeRawUnsafe(`INSERT INTO "Entity" (id,"kbId","canonicalName",type,context) VALUES ($1,$2,$3,$4,$5)`, id, source.kbId, entity.name, entity.type, entity.context);
      for (const alias of names) await tx.$executeRawUnsafe(`INSERT INTO "EntityAlias" (id,"entityId",alias,normalized) SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM "EntityAlias" WHERE "entityId"=$2 AND normalized=$4)`, randomUUID(), id, alias, normalizeName(alias));
      await tx.$executeRawUnsafe(`INSERT INTO "EntityMention" (id,"kbId","generationId","entityId","documentId","chunkId","sourceVersionId",start,"end","evidenceText","evidenceTextHash") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT ("chunkId","entityId",start) DO NOTHING`, randomUUID(), source.kbId, source.generationId, id, source.documentId, source.chunkId, source.sourceVersionId, entity.start, entity.end, entity.evidenceText, hash(entity.evidenceText));
    }
    const seen = new Set<string>();
    for (const relation of checked.relations) {
      let subject = ids.get(relation.subject)!; let object = ids.get(relation.object)!;
      if (relation.direction === 'symmetric' && subject > object) [subject, object] = [object, subject];
      const [row] = await tx.$queryRawUnsafe<{ id: string }[]>(`INSERT INTO "EntityRelation" (id,"kbId","generationId","schemaVersion","subjectId",predicate,"objectId","timeQualifier","conditionQualifier") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT ("generationId","subjectId",predicate,"objectId","timeQualifier","conditionQualifier") DO UPDATE SET "schemaVersion"=EXCLUDED."schemaVersion" RETURNING id`, randomUUID(), source.kbId, source.generationId, schema.version, subject, relation.predicate, object, relation.timeQualifier, relation.conditionQualifier);
      if (!row) throw new Error('GRAPH_RELATION_WRITE_FAILED');
      const key = `${row.id}:${relation.start}:${relation.end}`; if (seen.has(key)) continue; seen.add(key);
      await tx.$executeRawUnsafe(`INSERT INTO "RelationEvidence" (id,"relationId","documentId","sourceVersionId","chunkId",start,"end","evidenceText","evidenceTextHash") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, randomUUID(), row.id, source.documentId, source.sourceVersionId, source.chunkId, relation.start, relation.end, relation.evidenceText, hash(relation.evidenceText));
      // Different wording or qualifiers is a review candidate, never an asserted contradiction.
      await tx.$executeRawUnsafe(`DELETE FROM "DerivedFact" WHERE "relationId"=$1 AND "evidenceJson"->>'kind'='graph_review'`, row.id);
      await tx.$executeRawUnsafe(`INSERT INTO "DerivedFact" (id,"kbId","generationId",claim,"relationId","sourceDocumentIds","evidenceJson")
        SELECT $1,$2,$3,$4,$5,array_agg(DISTINCT e."documentId"),jsonb_build_object('kind','graph_review','status','needs_verification','reason','wording_or_qualifier_variation')
        FROM "EntityRelation" r JOIN "RelationEvidence" e ON e."relationId"=r.id WHERE r."kbId"=$2 AND r."generationId"=$3 AND r."subjectId"=$6 AND r.predicate=$7 AND r."objectId"=$8
        HAVING count(DISTINCT (r."timeQualifier",r."conditionQualifier",e."evidenceTextHash"))>1`, randomUUID(), source.kbId, source.generationId, `${subject} ${relation.predicate} ${object}`, row.id, subject, relation.predicate, object);
    }
    await tx.$executeRawUnsafe(`DELETE FROM "EntityRelation" r WHERE r."kbId"=$1 AND r."generationId"=$2 AND NOT EXISTS (SELECT 1 FROM "RelationEvidence" e WHERE e."relationId"=r.id)`, source.kbId, source.generationId);
  });
}
export async function deleteGraphSource(kbId: string, documentId: string, db: GraphDatabase = prisma): Promise<void> {
  await db.$transaction(async tx => {
    await tx.$queryRawUnsafe(`SELECT id FROM "KnowledgeBase" WHERE id=$1 FOR UPDATE`, kbId);
    await tx.$executeRawUnsafe(`DELETE FROM "EntityMention" WHERE "kbId"=$1 AND "documentId"=$2`, kbId, documentId);
    await tx.$executeRawUnsafe(`DELETE FROM "RelationEvidence" e USING "EntityRelation" r WHERE e."relationId"=r.id AND r."kbId"=$1 AND e."documentId"=$2`, kbId, documentId);
    await tx.$executeRawUnsafe(`DELETE FROM "DerivedFact" WHERE "kbId"=$1 AND "sourceDocumentIds" @> ARRAY[$2]::text[] AND cardinality(array_remove("sourceDocumentIds",$2))=0`, kbId, documentId);
    await tx.$executeRawUnsafe(`UPDATE "DerivedFact" SET "sourceDocumentIds"=array_remove("sourceDocumentIds",$2),"evidenceJson"=jsonb_build_object('status','needs_verification','reason','source_deleted') WHERE "kbId"=$1 AND "sourceDocumentIds" @> ARRAY[$2]::text[]`, kbId, documentId);
    await tx.$executeRawUnsafe(`DELETE FROM "EntityRelation" r WHERE r."kbId"=$1 AND NOT EXISTS (SELECT 1 FROM "RelationEvidence" e WHERE e."relationId"=r.id)`, kbId);
  });
}
