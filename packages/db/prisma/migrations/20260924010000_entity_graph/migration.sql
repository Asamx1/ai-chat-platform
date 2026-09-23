CREATE TABLE "Entity" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kbId" TEXT NOT NULL,
  "canonicalName" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "context" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "EntityAlias" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "entityId" TEXT NOT NULL,
  "alias" TEXT NOT NULL,
  "normalized" TEXT NOT NULL
);
CREATE TABLE "EntityMention" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kbId" TEXT NOT NULL,
  "generationId" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "chunkId" TEXT NOT NULL,
  "sourceVersionId" TEXT NOT NULL,
  "start" INTEGER NOT NULL,
  "end" INTEGER NOT NULL,
  "evidenceText" TEXT NOT NULL,
  "evidenceTextHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "EntityRelation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kbId" TEXT NOT NULL,
  "generationId" TEXT NOT NULL,
  "schemaVersion" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "predicate" TEXT NOT NULL,
  "objectId" TEXT NOT NULL,
  "timeQualifier" TEXT,
  "conditionQualifier" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "RelationEvidence" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "relationId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "sourceVersionId" TEXT NOT NULL,
  "chunkId" TEXT NOT NULL,
  "start" INTEGER NOT NULL,
  "end" INTEGER NOT NULL,
  "evidenceText" TEXT NOT NULL,
  "evidenceTextHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "DerivedFact" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kbId" TEXT NOT NULL,
  "generationId" TEXT NOT NULL,
  "claim" TEXT NOT NULL,
  "entityId" TEXT,
  "relationId" TEXT,
  "sourceDocumentIds" TEXT[] NOT NULL,
  "evidenceJson" JSONB NOT NULL,
  "wikidocId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "OntologyConfig" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kbId" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "schemaJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "Entity" ADD FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Entity_kbId_idx" ON "Entity" ("kbId");
ALTER TABLE "EntityAlias" ADD FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "EntityAlias_normalized_idx" ON "EntityAlias" ("normalized");
CREATE INDEX "EntityAlias_entityId_idx" ON "EntityAlias" ("entityId");
ALTER TABLE "EntityMention" ADD FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EntityMention" ADD FOREIGN KEY ("generationId") REFERENCES "IndexGeneration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EntityMention" ADD FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EntityMention" ADD FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EntityMention" ADD FOREIGN KEY ("chunkId") REFERENCES "Chunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EntityMention" ADD FOREIGN KEY ("sourceVersionId") REFERENCES "SourceVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "EntityMention_chunkId_entityId_start_key" ON "EntityMention" ("chunkId", "entityId", "start");
CREATE INDEX "EntityMention_kbId_generationId_idx" ON "EntityMention" ("kbId", "generationId");
CREATE INDEX "EntityMention_entityId_idx" ON "EntityMention" ("entityId");
ALTER TABLE "EntityRelation" ADD FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EntityRelation" ADD FOREIGN KEY ("generationId") REFERENCES "IndexGeneration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EntityRelation" ADD FOREIGN KEY ("subjectId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EntityRelation" ADD FOREIGN KEY ("objectId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "EntityRelation_fact_key" ON "EntityRelation" ("generationId", "subjectId", "predicate", "objectId", "timeQualifier", "conditionQualifier") NULLS NOT DISTINCT;
CREATE INDEX "EntityRelation_kbId_generationId_idx" ON "EntityRelation" ("kbId", "generationId");
CREATE INDEX "EntityRelation_subjectId_predicate_idx" ON "EntityRelation" ("subjectId", "predicate");
CREATE INDEX "EntityRelation_objectId_idx" ON "EntityRelation" ("objectId");
ALTER TABLE "RelationEvidence" ADD FOREIGN KEY ("relationId") REFERENCES "EntityRelation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RelationEvidence" ADD FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RelationEvidence" ADD FOREIGN KEY ("sourceVersionId") REFERENCES "SourceVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RelationEvidence" ADD FOREIGN KEY ("chunkId") REFERENCES "Chunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "RelationEvidence_relationId_idx" ON "RelationEvidence" ("relationId");
CREATE INDEX "RelationEvidence_documentId_idx" ON "RelationEvidence" ("documentId");
CREATE INDEX "RelationEvidence_chunkId_idx" ON "RelationEvidence" ("chunkId");
ALTER TABLE "DerivedFact" ADD FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DerivedFact" ADD FOREIGN KEY ("generationId") REFERENCES "IndexGeneration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DerivedFact" ADD FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DerivedFact" ADD FOREIGN KEY ("relationId") REFERENCES "EntityRelation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DerivedFact" ADD FOREIGN KEY ("wikidocId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "DerivedFact_kbId_generationId_idx" ON "DerivedFact" ("kbId", "generationId");
ALTER TABLE "OntologyConfig" ADD FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "OntologyConfig_kbId_version_key" ON "OntologyConfig" ("kbId", "version");

-- Enforce graph scope even when a caller bypasses the application writer.
CREATE FUNCTION entity_graph_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r "EntityRelation"; c "Chunk"; v "SourceVersion"; docid TEXT;
BEGIN
  IF TG_TABLE_NAME IN ('EntityMention','EntityRelation','DerivedFact') THEN
    IF NOT EXISTS (SELECT 1 FROM "IndexGeneration" WHERE id=NEW."generationId" AND "kbId"=NEW."kbId") THEN RAISE EXCEPTION 'GRAPH_GENERATION_SCOPE'; END IF;
  END IF;
  IF TG_TABLE_NAME='EntityRelation' THEN
    IF NOT EXISTS (SELECT 1 FROM "Entity" WHERE id=NEW."subjectId" AND "kbId"=NEW."kbId") OR NOT EXISTS (SELECT 1 FROM "Entity" WHERE id=NEW."objectId" AND "kbId"=NEW."kbId") THEN RAISE EXCEPTION 'GRAPH_ENTITY_SCOPE'; END IF;
    IF EXISTS (SELECT 1 FROM "EntityRelation" WHERE "generationId"=NEW."generationId" AND "schemaVersion"<>NEW."schemaVersion") THEN RAISE EXCEPTION 'GRAPH_SCHEMA_GENERATION_MISMATCH'; END IF;
  ELSIF TG_TABLE_NAME IN ('EntityMention','RelationEvidence') THEN
    SELECT * INTO c FROM "Chunk" WHERE id=NEW."chunkId";
    SELECT * INTO v FROM "SourceVersion" WHERE id=NEW."sourceVersionId";
    IF c.id IS NULL OR v.id IS NULL OR c."documentId"<>NEW."documentId" OR v."documentId"<>NEW."documentId" OR c."kbId"<>v."kbId" OR c."generationId" IS NULL THEN RAISE EXCEPTION 'GRAPH_SOURCE_SCOPE'; END IF;
    IF TG_TABLE_NAME='EntityMention' THEN
      IF c."kbId"<>NEW."kbId" OR c."generationId"<>NEW."generationId" OR NOT EXISTS (SELECT 1 FROM "Entity" WHERE id=NEW."entityId" AND "kbId"=NEW."kbId") THEN RAISE EXCEPTION 'GRAPH_MENTION_SCOPE'; END IF;
    ELSE
      SELECT * INTO r FROM "EntityRelation" WHERE id=NEW."relationId";
      IF r.id IS NULL OR r."kbId"<>c."kbId" OR r."generationId"<>c."generationId" THEN RAISE EXCEPTION 'GRAPH_EVIDENCE_SCOPE'; END IF;
    END IF;
    IF NEW.start<0 OR NEW."end"<=NEW.start THEN RAISE EXCEPTION 'GRAPH_INVALID_SPAN'; END IF;
  ELSIF TG_TABLE_NAME='DerivedFact' THEN
    IF NEW."entityId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Entity" WHERE id=NEW."entityId" AND "kbId"=NEW."kbId") THEN RAISE EXCEPTION 'GRAPH_FACT_ENTITY_SCOPE'; END IF;
    IF NEW."relationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "EntityRelation" WHERE id=NEW."relationId" AND "kbId"=NEW."kbId" AND "generationId"=NEW."generationId") THEN RAISE EXCEPTION 'GRAPH_FACT_RELATION_SCOPE'; END IF;
    IF NEW."wikidocId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Document" WHERE id=NEW."wikidocId" AND "kbId"=NEW."kbId" AND kind IN ('WIKI_SUMMARY','WIKI_ENTITY')) THEN RAISE EXCEPTION 'GRAPH_FACT_WIKI_SCOPE'; END IF;
    FOREACH docid IN ARRAY NEW."sourceDocumentIds" LOOP
      IF NOT EXISTS (SELECT 1 FROM "Document" WHERE id=docid AND "kbId"=NEW."kbId" AND kind='SOURCE') THEN RAISE EXCEPTION 'GRAPH_FACT_SOURCE_SCOPE'; END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER graph_scope BEFORE INSERT OR UPDATE ON "EntityMention" FOR EACH ROW EXECUTE FUNCTION entity_graph_scope();
CREATE TRIGGER graph_scope BEFORE INSERT OR UPDATE ON "EntityRelation" FOR EACH ROW EXECUTE FUNCTION entity_graph_scope();
CREATE TRIGGER graph_scope BEFORE INSERT OR UPDATE ON "RelationEvidence" FOR EACH ROW EXECUTE FUNCTION entity_graph_scope();
CREATE TRIGGER graph_scope BEFORE INSERT OR UPDATE ON "DerivedFact" FOR EACH ROW EXECUTE FUNCTION entity_graph_scope();

CREATE FUNCTION entity_graph_orphan_relation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "EntityRelation" r WHERE r.id=OLD."relationId" AND NOT EXISTS (SELECT 1 FROM "RelationEvidence" e WHERE e."relationId"=r.id);
  RETURN NULL;
END $$;
-- Deferred so replacing a chunk's evidence cannot delete the relation midway through replay.
CREATE CONSTRAINT TRIGGER graph_orphan_relation AFTER DELETE ON "RelationEvidence" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION entity_graph_orphan_relation();
CREATE FUNCTION entity_graph_delete_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "DerivedFact" WHERE "kbId"=OLD."kbId" AND "sourceDocumentIds" @> ARRAY[OLD.id] AND cardinality(array_remove("sourceDocumentIds",OLD.id))=0;
  UPDATE "DerivedFact" SET "sourceDocumentIds"=array_remove("sourceDocumentIds",OLD.id),
    "evidenceJson"=jsonb_build_object('status','needs_verification','reason','source_deleted')
    WHERE "kbId"=OLD."kbId" AND "sourceDocumentIds" @> ARRAY[OLD.id];
  RETURN OLD;
END $$;
CREATE TRIGGER graph_delete_source BEFORE DELETE ON "Document" FOR EACH ROW EXECUTE FUNCTION entity_graph_delete_source();
CREATE INDEX "DerivedFact_sources_idx" ON "DerivedFact" USING gin ("sourceDocumentIds");
