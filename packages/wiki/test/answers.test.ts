import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import type { PrismaClient } from '@aichat/db';
import { archiveAnswer, type ArchiveAnswerOptions } from '../src/answers.js';
import { sha256 } from '../src/scan.js';

it('archives sourced answers with quoted frontmatter and overwrites the same daily question', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-answers-'));
  const db = { vaultRelease: { findUnique: async () => ({ status: 'committed' }) } } as unknown as PrismaClient;
  const opts: ArchiveAnswerOptions = { vaultPath: root, question: 'Alpha?\n---', model: 'stub-v1', now: new Date('2026-09-26T10:00:00Z'),
    answer: 'Alpha is a class. [a]', revision: 'rev-002', citations: [{ assertionId: 'a', origin: 'sourced', quote: 'Alpha is a class.',
      locator: { kind: 'page', page: 3 }, sourceTitle: 'Taxonomy', sourceId: 'src', sourceFile: 'raw/a.pdf', sourceSha256: 'hash' }] };
  try {
    const first = await archiveAnswer('v', db, opts);
    expect(first.file).toBe(join(root, 'wiki/answers/2026-09-26', `${sha256(opts.question).slice(0, 12)}.md`));
    const before = await readFile(first.file, 'utf8');
    expect(await archiveAnswer('v', db, opts)).toEqual(first);
    expect(await readFile(first.file, 'utf8')).toBe(before);
    expect(await readdir(dirname(first.file))).toEqual([`${sha256(opts.question).slice(0, 12)}.md`]);
    expect(before).toContain('usedAssertionIds: ["a"]');
    expect(before).toContain('model: "stub-v1"');
    expect(before).toContain('quote: "Alpha is a class."');
    expect(before).toContain('locator: {"kind":"page","page":3}');
    await archiveAnswer('v', db, { ...opts, answer: 'Updated answer. [a]' });
    expect(await readFile(first.file, 'utf8')).toContain('Updated answer. [a]');
  } finally { await rm(root, { recursive: true, force: true }); }
});
