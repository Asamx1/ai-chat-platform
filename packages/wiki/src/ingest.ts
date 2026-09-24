import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkAssertion, loadConstraints, loadOntology, type Assertion, type Constraints, type Ontology } from '@aichat/ontology';
import type { PrismaClient } from '@aichat/db';
import { database, listRawFiles, registerSource, scanRawFile } from './scan';
import { parseSource, type PdfReader, type ParsedDoc } from './parse';
import { extractAssertions, normalizeEntities, proposeAliases, type Llm, type Rejected } from './extract';
export interface IngestOptions {
  vaultId?: string; userId?: string; db?: PrismaClient; ontology?: Ontology; constraints?: Constraints;
  resumeRegistered?: boolean; expectedSha256?: string;
  llm?: Llm; normalizeLlm?: Llm; pdfReader?: PdfReader;
  documentParser?: (source: Awaited<ReturnType<typeof registerSource>>['source']) => Promise<ParsedDoc & { qualityInsufficient?: boolean; reasons?: string[] }>;
}
export interface IngestReport {
  file: string; sourceId: string | null; familyId: string | null; isDuplicate: boolean; needsOcr: boolean;
  state: 'failed' | 'duplicate' | 'pending-p3-ocr' | 'ingested'; candidatesIn: number; candidatesOut: number;
  assertionsAccepted: string[]; assertionsRejected: Rejected[]; entitiesCreated: number; entitiesMerged: number;
  errors: Array<{ stage: string; reason: string }>;
  sourceType?: 'multimodal'; qualityInsufficient?: boolean; reasons?: string[];
}
export async function ingestFile(vaultPath: string, relPath: string, opts: IngestOptions = {}): Promise<IngestReport> {
  const report: IngestReport = { file: relPath, sourceId: null, familyId: null, isDuplicate: false, needsOcr: false,
    state: 'failed', candidatesIn: 0, candidatesOut: 0, assertionsAccepted: [], assertionsRejected: [], entitiesCreated: 0, entitiesMerged: 0, errors: [] };
  let stage = 'scan';
  try {
    const file = await scanRawFile(vaultPath, relPath);
    if (opts.expectedSha256 && file.sha256 !== opts.expectedSha256) throw new Error('RAW_HASH_CHANGED');
    const db = opts.db ?? await database();
    const vaultId = opts.vaultId ?? 'default';
    stage = 'register';
    const { source, family, isDuplicate } = await registerSource(file, vaultId, db);
    Object.assign(report, { sourceId: source.id, familyId: family.id, isDuplicate });
    // Backlog retries must resume sources registered before an extraction failure.
    if (isDuplicate && (!opts.resumeRegistered || await db.vaultEvidence.count({ where: { vaultId, sourceId: source.id } }) > 0)) { report.state = 'duplicate'; return report; }
    stage = 'parse';
    const doc: ParsedDoc & { qualityInsufficient?: boolean; reasons?: string[] } = opts.documentParser ? await opts.documentParser(source) : await parseSource(source, vaultPath, opts.pdfReader);
    if (doc.qualityInsufficient) {
      report.qualityInsufficient = true;
      report.reasons = doc.reasons ?? [];
      report.needsOcr = doc.needsOcr;
      report.state = doc.needsOcr ? 'pending-p3-ocr' : 'failed';
      return report;
    }
    if (doc.needsOcr) { report.needsOcr = true; report.state = 'pending-p3-ocr'; return report; }
    stage = 'schema';
    const ontology = opts.ontology ?? loadOntology(await readFile(resolve(vaultPath, 'schema/ontology.yaml'), 'utf8'));
    const constraints = opts.constraints ?? loadConstraints(await readFile(resolve(vaultPath, 'schema/constraints.yaml'), 'utf8'));
    stage = 'extract';
    const candidates = await extractAssertions(doc, source, ontology, { constraints,
      ...(opts.llm ? { llm: opts.llm } : {}), ...(opts.userId ? { userId: opts.userId } : {}) });
    report.candidatesIn = candidates.candidatesIn;
    report.assertionsRejected = candidates.rejected;
    stage = 'normalize';
    // Finish all network work before opening the write transaction.
    const proposals = await proposeAliases(candidates, opts.normalizeLlm);
    stage = 'persist';
    const written = await db.$transaction(async tx => {
      const normalized = await normalizeEntities(candidates, vaultId, { tx, proposals });
      const accepted: string[] = []; const rejected: Rejected[] = [];
      const checked: Assertion[] = [];
      for (const candidate of candidates.assertions) {
        const a = candidate.assertion;
        const subjectId = normalized.ids.get(a.subject.id);
        const objectId = a.object ? normalized.ids.get(a.object.id) : undefined;
        if (!subjectId || (a.object && !objectId)) throw new Error('NORMALIZATION_ENDPOINT_MISSING');
        const normalizedAssertion = { ...a, subject: { ...a.subject, id: subjectId }, ...(a.object && objectId ? { object: { ...a.object, id: objectId } } : {}) };
        const violations = checkAssertion(normalizedAssertion, ontology, constraints, checked);
        if (violations.length) { rejected.push({ item: candidate, reason: violations.map(v => `${v.code}: ${v.message}`).join('; ') }); continue; }
        checked.push(normalizedAssertion);
        await tx.vaultAssertion.create({ data: { id: a.id, vaultId, subjectId, predicate: a.predicate,
          ...(objectId ? { objectId } : { value: JSON.stringify(a.value) }), polarity: a.polarity === 'positive',
          conditions: JSON.stringify({ ...a.context, ...(a.unit === undefined ? {} : { unit: a.unit }),
            ...(a.dataset === undefined ? {} : { dataset: a.dataset }), ...(a.metric === undefined ? {} : { metric: a.metric }),
            ...(a.testSettings === undefined ? {} : { testSettings: a.testSettings }) }),
          validFrom: a.validTime.from, validTo: a.validTime.to, status: 'candidate', origin: 'sourced', revision: 'rev-000',
          ruleVersion: a.ruleVersion, ontologyVersion: ontology.version } });
        await tx.vaultEvidence.create({ data: { vaultId, assertionId: a.id, sourceId: source.id, sourceSha256: source.sha256,
          locatorKind: candidate.locator.kind, locatorJson: JSON.stringify(candidate.locator), quote: candidate.quote, stance: 'supports' } });
        accepted.push(a.id);
      }
      return { normalized, accepted, rejected };
    });
    report.assertionsAccepted = written.accepted;
    report.assertionsRejected.push(...written.rejected);
    report.candidatesOut = written.accepted.length;
    report.entitiesCreated = written.normalized.entitiesCreated;
    report.entitiesMerged = written.normalized.entitiesMerged;
    report.state = 'ingested';
  } catch (error) { report.errors.push({ stage, reason: error instanceof Error ? error.message : String(error) }); }
  return report;
}
export async function ingestVault(vaultPath: string, opts: IngestOptions = {}): Promise<IngestReport[]> {
  const reports: IngestReport[] = [];
  for (const file of await listRawFiles(vaultPath)) reports.push(await ingestFile(vaultPath, file, opts));
  return reports;
}
