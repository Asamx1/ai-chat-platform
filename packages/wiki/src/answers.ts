import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { PrismaClient } from '@aichat/db';
import type { Citation, StrictAnswer } from './query.js';
import { sha256 } from './scan.js';

type AnswerContent = { answer: string; citations: Citation[]; revision: string }
  | { answer: Exclude<StrictAnswer, { kind: 'unknown' }> };
export type ArchiveAnswerOptions = AnswerContent & {
  vaultPath: string; question: string; model: string; now?: Date;
};
export async function archiveAnswer(vaultId: string, db: PrismaClient, opts: ArchiveAnswerOptions): Promise<{ file: string }> {
  const content = typeof opts.answer === 'string' ? opts as ArchiveAnswerOptions & { answer: string; citations: Citation[]; revision: string } : opts.answer;
  if ((typeof opts.answer !== 'string' && opts.answer.kind !== 'sourced') || !content.answer.trim()
    || !content.citations.length || content.citations.some(c => c.origin !== 'sourced' || !c.quote.trim())
    || !opts.question.trim() || !opts.model.trim()) throw new Error('SOURCED_ANSWER_REQUIRED');
  const release = await db.vaultRelease.findUnique({ where: { vaultId_revision: { vaultId, revision: content.revision } } });
  if (release?.status !== 'committed') throw new Error('ANSWER_REVISION_NOT_COMMITTED');
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const file = resolve(opts.vaultPath, 'wiki/answers', date, `${sha256(opts.question).slice(0, 12)}.md`);
  const usedAssertionIds = [...new Set(content.citations.map(c => c.assertionId))];
  // JSON scalars/arrays are valid YAML and safely quote newlines and frontmatter delimiters.
  const frontmatter = Object.entries({ question: opts.question, revision: content.revision, model: opts.model, usedAssertionIds, vaultId })
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
  const citations = content.citations.map(c => `- [${c.assertionId}] ${JSON.stringify(c.sourceTitle)} (${JSON.stringify(c.sourceFile)})\n`
    + `  - locator: ${JSON.stringify(c.locator)}\n  - quote: ${JSON.stringify(c.quote)}`).join('\n');
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `---\n${frontmatter}\n---\n\n${content.answer}\n\n## 引用\n\n${citations}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
  return { file };
}
