import { prisma } from '@aichat/db';
import { retrieve, type Hit, type RetrieveOptions } from '../retrieve';
import { runEvaluation, type EvalRunConfig, type EvalRunReport } from './runner';
import type { EvidenceMetrics } from './metrics';

export type AblationArmName = 'baseline' | 'semantic' | 'wiki' | 'graph' | 'combined';
export type AblationArm = Readonly<{ name: AblationArmName; strategy: 'structure' | 'semantic'; switches: Readonly<{ wiki: boolean; graph: boolean }>; retrieveOptions: Readonly<RetrieveOptions> }>;

/** The same retrieval budget and SOURCE corpus are used by every arm. */
export function ablationArms(graphWeight = 0.35): readonly AblationArm[] {
  const arm = (name: AblationArmName, strategy: AblationArm['strategy'], wiki: boolean, graph: boolean): AblationArm =>
    Object.freeze({ name, strategy, switches: Object.freeze({ wiki, graph }), retrieveOptions: Object.freeze({
      includeKinds: Object.freeze(wiki ? ['SOURCE', 'WIKI_SUMMARY'] as const : ['SOURCE'] as const),
      graphWeight: graph ? graphWeight : 0, switches: Object.freeze({ wiki, graph }),
    }) });
  return Object.freeze([arm('baseline', 'structure', false, false), arm('semantic', 'semantic', false, false),
    arm('wiki', 'structure', true, false), arm('graph', 'structure', false, true), arm('combined', 'semantic', true, true)]);
}

export type ArmCost = { usd: number | null; inputTokens: number; outputTokens: number; unknownCostCount: number };
export type AblationRow = { arm: AblationArmName; status: 'completed' | 'skipped'; reason?: string;
  generation: string; metrics?: EvidenceMetrics; byQuestionType?: EvalRunReport['summary']['byQuestionType'];
  cost?: ArmCost; meanLatencyMs?: number; degradedQuestions: { id: string; baseline: number; arm: number }[];
  report?: EvalRunReport };
export type AblationReport = { corpusSnapshotId: string; datasetPath: string; rows: AblationRow[] };

async function generationCost(generationId: string): Promise<ArmCost> {
  const rows = await prisma.compileCostLedger.findMany({ where: { compileJob: { generationId } },
    select: { costUsd: true, inputTokens: true, outputTokens: true } });
  return { usd: rows.some(row => row.costUsd === null) ? null : rows.reduce((sum, row) => sum + Number(row.costUsd), 0),
    inputTokens: rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
    outputTokens: rows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
    unknownCostCount: rows.filter(row => row.costUsd === null).length };
}

export type AblationConfig = Omit<EvalRunConfig, 'generation' | 'strategy' | 'switches' | 'reportPath' | 'retriever' | 'retrieveOptions'> & {
  kbId: string;
  generations: Record<AblationArmName, string | undefined>;
  retriever?: (userId: string, conversationId: string, question: string, options: RetrieveOptions) => Promise<Hit[]>;
  cost?: (generation: string) => Promise<ArmCost>;
  skip?: Partial<Record<AblationArmName, string>>;
};

export async function runAblation(config: AblationConfig): Promise<AblationReport> {
  const rows: AblationRow[] = [];
  let baseline: EvalRunReport | undefined;
  for (const arm of ablationArms()) {
    const generation = config.generations[arm.name];
    if (!generation || config.skip?.[arm.name]) {
      rows.push({ arm: arm.name, status: 'skipped', reason: config.skip?.[arm.name] ?? 'generation unavailable',
        generation: generation ?? '', degradedQuestions: [] });
      continue;
    }
    const options: RetrieveOptions = { ...arm.retrieveOptions, generationOverrides: { [config.kbId]: generation } };
    const report = await runEvaluation({ ...config, generation, strategy: arm.strategy, switches: { ...arm.switches },
      retrieveOptions: options,
      retriever: (userId, conversationId, question) => (config.retriever ?? retrieve)(userId, conversationId, question, options) });
    if (arm.name === 'baseline') baseline = report;
    const reference = new Map(baseline?.questions.map(row => [row.id, row.metrics.evidenceCoverageAt5]));
    rows.push({ arm: arm.name, status: 'completed', generation, metrics: report.summary.metrics,
      byQuestionType: report.summary.byQuestionType, cost: await (config.cost ?? generationCost)(generation),
      meanLatencyMs: report.questions.length ? report.questions.reduce((sum, row) => sum + row.elapsedMs, 0) / report.questions.length : 0,
      degradedQuestions: report.questions.flatMap(row => {
        const before = reference.get(row.id);
        return before !== undefined && row.metrics.evidenceCoverageAt5 < before
          ? [{ id: row.id, baseline: before, arm: row.metrics.evidenceCoverageAt5 }] : [];
      }), report });
  }
  return { corpusSnapshotId: config.corpusSnapshotId, datasetPath: config.datasetPath, rows };
}
