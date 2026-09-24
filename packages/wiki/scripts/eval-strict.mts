import 'dotenv/config';
import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { z } from 'zod';
import type { PrismaClient } from '@aichat/db';
import { answerStrict } from '../src/query.js';
import { deepseekLlm, type Llm } from '../src/extract.js';
import { database } from '../src/scan.js';

const types = ['fact', 'synonym', 'single_source', 'version_scope', 'unanswerable', 'out_of_scope'] as const;
const dataset = z.object({ cases: z.array(z.object({ id: z.string(), question: z.string(), questionType: z.enum(types), answerable: z.boolean(),
  sourceFile: z.string(), evidenceAnchors: z.array(z.object({ page: z.number().optional(), file: z.string().optional() })) })) });
let db: PrismaClient | undefined;
try {
  const { values } = parseArgs({ options: {
    eval: { type: 'string', default: 'docs/eval/ontology-eval-draft.json' }, vault: { type: 'string', default: '/mnt/d/wiki-vault' },
    'vault-id': { type: 'string', default: 'default' }, 'user-id': { type: 'string' },
    out: { type: 'string', default: 'docs/eval/strict-qa-report.json' }, limit: { type: 'string' },
  } });
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('--limit must be a positive integer');
  const cases = dataset.parse(JSON.parse(await readFile(values.eval, 'utf8'))).cases.slice(0, limit);
  db = await database();
  const provider = deepseekLlm(values['user-id'] ?? process.env.AICHAT_USER_ID);
  let llmCalls = 0; let estimatedInputTokens = 0; let estimatedOutputTokens = 0;
  const llm: Llm = async request => {
    llmCalls++; estimatedInputTokens += Math.ceil((request.system.length + request.prompt.length) / 4);
    const output = await provider(request); estimatedOutputTokens += Math.ceil((JSON.stringify(output) ?? '').length / 4); return output;
  };
  const started = Date.now();
  const results: Array<{ id: string; questionType: string; answerable: boolean; correct: boolean; actual: Awaited<ReturnType<typeof answerStrict>>; anchorCount: number; fileMatches: number; pageFileMatches: number; elapsedMs: number }> = [];
  for (const item of cases) {
    const start = Date.now();
    const actual = await answerStrict(item.question, values['vault-id'], values.vault, db, { llm });
    const correct = item.answerable ? actual.kind === 'sourced' : actual.kind === 'unknown';
    const anchors = item.answerable ? item.evidenceAnchors : [];
    const fileMatches = anchors.filter(anchor => actual.citations.some(c => basename(c.sourceFile) === basename(anchor.file ?? item.sourceFile))).length;
    const pageFileMatches = anchors.filter(anchor => actual.citations.some(c => basename(c.sourceFile) === basename(anchor.file ?? item.sourceFile)
      && (anchor.page === undefined || (c.locator.kind === 'page' && c.locator.page === anchor.page)))).length;
    results.push({ id: item.id, questionType: item.questionType, answerable: item.answerable, correct, actual,
      anchorCount: anchors.length, fileMatches, pageFileMatches, elapsedMs: Date.now() - start });
  }
  const ratio = (n: number, d: number) => d ? n / d : 0;
  const count = results.length; const correct = results.filter(r => r.correct).length;
  const anchorCount = results.reduce((n, r) => n + r.anchorCount, 0);
  const report = { generatedAt: new Date().toISOString(), total: count, correct, accuracy: ratio(correct, count),
    byType: Object.fromEntries(types.map(type => { const rows = results.filter(r => r.questionType === type); const right = rows.filter(r => r.correct).length;
      return [type, { total: rows.length, correct: right, accuracy: ratio(right, rows.length) }]; })),
    correctRefusals: results.filter(r => !r.answerable && r.actual.kind === 'unknown').length,
    falseAnswers: results.filter(r => !r.answerable && r.actual.kind !== 'unknown').length,
    missedAnswers: results.filter(r => r.answerable && r.actual.kind === 'unknown').length,
    retrievalFailures: results.filter(r => r.actual.kind === 'unknown' && r.actual.reason === 'RETRIEVAL_FAILED').length,
    averageCitations: ratio(results.reduce((n, r) => n + r.actual.citations.length, 0), count),
    citationQuality: { anchorCount, fileOverlap: ratio(results.reduce((n, r) => n + r.fileMatches, 0), anchorCount),
      pageAndFileOverlap: ratio(results.reduce((n, r) => n + r.pageFileMatches, 0), anchorCount) },
    elapsedMs: Date.now() - started, llmCalls, estimatedInputTokens, estimatedOutputTokens, tokenEstimateMethod: 'ceil(characters / 4), not provider usage',
    errors: results.filter(r => !r.correct).map(r => ({ id: r.id, answerable: r.answerable, actual: r.actual })), results };
  await mkdir(dirname(values.out), { recursive: true });
  await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
  const { results: _results, ...summary } = report;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;
} finally { await db?.$disconnect(); }
