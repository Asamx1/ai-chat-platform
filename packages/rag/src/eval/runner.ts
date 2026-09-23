import { readFile, writeFile } from 'node:fs/promises';
import { prisma } from '@aichat/db';
import { retrieve } from '../retrieve';
import type { Hit, RetrieveOptions } from '../retrieve';
import { calculateEvidenceMetrics } from './metrics';
import type { EvidenceMetrics } from './metrics';
import { evalDatasetSchema } from './types';
import type { EvalCase, QuestionType, RetrievalUnit } from './types';

export type EvalRunConfig = {
  datasetPath: string; reportPath?: string; userId: string; conversationId: string;
  corpusSnapshotId: string; generation: string; sourceVersions: Record<string, string>;
  commit: string; embeddingModel: string; strategy: string; switches: Record<string, boolean>;
  contextTokenBudget?: number; split?: 'DEV' | 'HELDOUT';
  retrieveOptions?: RetrieveOptions;
  retriever?: (userId: string, conversationId: string, question: string) => Promise<Hit[]>;
  locate?: (hits: readonly Hit[], config: EvalRunConfig, kbId: string) => Promise<RetrievalUnit[]>;
};

export type EvalQuestionReport = { id: string; questionType: QuestionType; split: EvalCase['split']; metrics: EvidenceMetrics; hits: RetrievalUnit[]; elapsedMs: number; error?: string };
export type EvalRunReport = {
  metadata: { commit: string; corpusSnapshotId: string; datasetVersion: string; generation: string; strategy: string; switches: Record<string, boolean>; embeddingModel: string; contextTokenBudget: number; startedAt: string; completedAt: string };
  questions: EvalQuestionReport[];
  summary: { count: number; metrics: EvidenceMetrics; byQuestionType: Partial<Record<QuestionType, { count: number; metrics: EvidenceMetrics }>> };
};

const zero = (): EvidenceMetrics => ({ evidenceHitRateAt5: 0, evidenceCoverageAt5: 0, evidenceMRRAt5: 0, documentHitRateAt5: 0 });
const keys = Object.keys(zero()) as (keyof EvidenceMetrics)[];
function mean(rows: readonly EvalQuestionReport[]): EvidenceMetrics {
  const result = zero();
  for (const key of keys) result[key] = rows.length ? rows.reduce((sum, row) => sum + row.metrics[key], 0) / rows.length : 0;
  return result;
}

/** Resolve offsets for already authorized hits under the same user, conversation, KB and model boundary. */
export async function locateAuthorizedHits(hits: readonly Hit[], config: EvalRunConfig, kbId: string): Promise<RetrievalUnit[]> {
  const located: RetrievalUnit[] = [];
  for (const hit of hits) {
    const rows = await prisma.$queryRawUnsafe<Array<{ start: number; end: number; text: string }>>(
      `SELECT CASE WHEN c.text=$3 THEN c.start ELSE c.start+strpos(c.text,$3)-1 END AS start,
              CASE WHEN c.text=$3 THEN c."end" ELSE c.start+strpos(c.text,$3)-1+length($3) END AS "end",$3::text AS text FROM "Chunk" c
       JOIN "Document" d ON d.id=c."documentId"
       JOIN "KnowledgeBase" k ON k.id=d."kbId"
       JOIN "ConversationKnowledgeBase" m ON m."kbId"=k.id
       JOIN "Conversation" v ON v.id=m."conversationId"
       WHERE c."documentId"=$1 AND c.ordinal=$2 AND strpos(c.text,$3)>0 AND k.id=$4
         AND k."userId"=$5 AND v."ownerId"=$5 AND v.id=$6
         AND d.status='READY' AND d.model=$7 AND c."generationId"=$8
         AND d."sourceVersionId"=$9 LIMIT 1`,
      hit.documentId, hit.ordinal, hit.text, kbId, config.userId, config.conversationId, config.embeddingModel,
      config.generation, config.sourceVersions[hit.documentId] ?? '',
    );
    const row = rows[0];
    const version = config.sourceVersions[hit.documentId];
    if (row) located.push({ sourceDocumentId: hit.documentId,
      ...(version ? { sourceVersionId: version } : {}),
      start: row.start, end: row.end, text: row.text, origin: 'SOURCE' });
    else located.push({ sourceDocumentId: '', text: hit.text });
  }
  return located;
}

/** Run approved evaluation cases through the production retrieval entry and write a reproducible report. */
export async function runEvaluation(config: EvalRunConfig): Promise<EvalRunReport> {
  const budget = config.contextTokenBudget ?? 4_000;
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new RangeError('contextTokenBudget must be positive');
  const dataset = evalDatasetSchema.parse(JSON.parse(await readFile(config.datasetPath, 'utf8')));
  const startedAt = new Date().toISOString();
  const questions: EvalQuestionReport[] = [];
  for (const item of dataset.cases) {
    if (item.reviewStatus !== 'APPROVED' || (config.split && item.split !== config.split)) continue;
    const start = Date.now();
    try {
      const hits = config.retriever
        ? await config.retriever(config.userId, config.conversationId, item.question)
        : await retrieve(config.userId, config.conversationId, item.question, config.retrieveOptions);
      const units = await (config.locate ?? locateAuthorizedHits)(hits, config, item.kbId);
      let remaining = budget;
      const context = units.filter(unit => {
        const tokens = Math.ceil([...unit.text].length / 4);
        if (tokens > remaining) return false;
        remaining -= tokens;
        return true;
      });
      questions.push({ id: item.id, questionType: item.questionType, split: item.split, metrics: calculateEvidenceMetrics(context, item.evidenceAnchors, item.evidenceGroups), hits: context, elapsedMs: Date.now() - start });
    } catch (error) {
      questions.push({ id: item.id, questionType: item.questionType, split: item.split, metrics: zero(), hits: [], elapsedMs: Date.now() - start, error: error instanceof Error ? error.message : 'UNKNOWN_ERROR' });
    }
  }
  const byQuestionType: EvalRunReport['summary']['byQuestionType'] = {};
  for (const type of new Set(questions.map(row => row.questionType))) {
    const rows = questions.filter(row => row.questionType === type);
    byQuestionType[type] = { count: rows.length, metrics: mean(rows) };
  }
  const report: EvalRunReport = {
    metadata: { commit: config.commit, corpusSnapshotId: config.corpusSnapshotId, datasetVersion: dataset.version, generation: config.generation, strategy: config.strategy, switches: config.switches, embeddingModel: config.embeddingModel, contextTokenBudget: budget, startedAt, completedAt: new Date().toISOString() },
    questions, summary: { count: questions.length, metrics: mean(questions), byQuestionType },
  };
  if (config.reportPath) await writeFile(config.reportPath, JSON.stringify(report, null, 2), 'utf8');
  return report;
}
