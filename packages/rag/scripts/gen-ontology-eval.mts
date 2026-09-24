import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { prisma } from '@aichat/db';
import { checkVaultQuestionTypeCoverage, generateVaultCandidates, vaultQuestionTypeSchema } from '../src/eval/vault-gen.ts';
import type { VaultEvalCase } from '../src/eval/vault-gen.ts';

const defaultSources = ['RAG的介绍', 'RAG的优化', 'MCP介绍', 'MCP初体验', 'Langchain-memory记忆', '手写MCP服务器与客户端', '常见向量数据库的介绍', '手搓一个Agent'];
const sourceRoot = '/mnt/d/wiki-vault/raw/articles';
const model = 'deepseek-chat';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    sources: { type: 'string' }, out: { type: 'string', default: 'docs/eval/ontology-eval-draft.json' }, userId: { type: 'string' },
  }, strict: true, allowPositionals: false });
  const sources = [...new Set(values.sources === undefined ? defaultSources.map(name => `${name}.pdf`) : values.sources.split(',').map(name => name.trim()).filter(Boolean))];
  if (!sources.length) throw new Error('--sources must contain at least one PDF');
  const userId = values.userId ?? (await prisma.apiKey.findFirst({ where: { provider: 'deepseek' }, orderBy: { userId: 'asc' }, select: { userId: true } }))?.userId;
  const cases: VaultEvalCase[] = [];
  const failures: { sourceFile: string; reason: string }[] = [];
  let successfulSources = 0;
  for (const source of sources) {
    const sourceFile = basename(source);
    try {
      if (!userId) throw new Error('NO_DEEPSEEK_API_KEY_USER');
      // The library extracts pages, generates and validates against the same file bytes.
      const generated = await generateVaultCandidates({ userId, sourceFile, pdfPath: isAbsolute(source) ? source : join(sourceRoot, source), model });
      if (!generated.length) throw new Error('SOURCE_GENERATION_FAILED_OR_EMPTY');
      cases.push(...generated);
      successfulSources++;
    } catch (error) {
      failures.push({ sourceFile, reason: error instanceof Error ? error.message : 'SOURCE_FAILED' });
      console.error(`Skipped ${sourceFile}: ${failures[failures.length - 1]?.reason}`);
    }
  }
  const questionTypeCounts = Object.fromEntries(vaultQuestionTypeSchema.options.map(type => [type, cases.filter(item => item.questionType === type).length]));
  const missingQuestionTypes = vaultQuestionTypeSchema.options.filter(type => !cases.some(item => item.questionType === type));
  const statistics = {
    questionTypeCounts, answerable: { true: cases.filter(item => item.answerable).length, false: cases.filter(item => !item.answerable).length },
    totalAnchors: cases.reduce((total, item) => total + item.evidenceAnchors.length, 0),
    allQuestionTypesCovered: checkVaultQuestionTypeCoverage(cases), missingQuestionTypes,
  };
  const output = resolve(values.out!);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), model, totalSources: sources.length,
    successfulSources, failures, statistics, cases }, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ output, totalCases: cases.length, failures: failures.length, ...statistics }, null, 2));
  if (missingQuestionTypes.length) console.error(`Incomplete questionType coverage: ${missingQuestionTypes.join(', ')}`);
}

try { await main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : 'GENERATION_FAILED');
  process.exitCode = 1;
} finally { await prisma.$disconnect(); }
