import { lstat, readFile, readdir } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import type { PrismaClient } from '@aichat/db';
import { links } from './publish';
import { pageSlug } from './promote';
import { canonicalJson } from './jobs';

export interface LintIssue {
  category: 'structure' | 'provenance' | 'conflicts' | 'timeliness';
  code: string; message: string; path?: string; assertionIds?: string[]; sourceIds?: string[];
}
export interface LintReport { vaultId: string; issues: LintIssue[] }
async function markdown(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function walk(path: string): Promise<void> {
    try { if ((await lstat(resolve(root, path))).isSymbolicLink()) throw new Error(`SYMLINK_IN_WIKI: ${path}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of await readdir(resolve(root, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`SYMLINK_IN_WIKI: ${child}`);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && child.endsWith('.md')) files.set(child, await readFile(resolve(root, child), 'utf8'));
    }
  }
  await walk('wiki');
  return files;
}
export async function lintStructure(vaultPath: string, vaultId: string, db: PrismaClient): Promise<LintIssue[]> {
  const files = await markdown(vaultPath);
  const entities = await db.vaultEntityCandidate.findMany({ where: { vaultId } });
  const published = await db.vaultPage.findMany({ where: { vaultId, kind: 'concept' } });
  const targets = new Set([...files.keys()].map(p => p.slice(5, -3)));
  const candidates = new Set(entities.filter(e => e.status === 'candidate').map(e => `concepts/${pageSlug(e.canonicalName)}`));
  const issues: LintIssue[] = [];
  for (const [path, text] of files) for (const target of links(text)) {
    if (!target) continue;
    const relative = posix.normalize(posix.join(posix.dirname(path.slice(5)), target));
    if (!targets.has(target) && !targets.has(relative) && [...targets].filter(t => posix.basename(t) === target).length !== 1 && !candidates.has(target))
      issues.push({ category: 'structure', code: 'BROKEN_LINK', path, message: `${path} -> ${target}` });
  }
  const indexed = new Set(links(files.get('wiki/index.md') ?? ''));
  for (const path of files.keys()) if (/^wiki\/concepts\/[^/]+\.md$/u.test(path) && !indexed.has(path.slice(5, -3)))
    issues.push({ category: 'structure', code: 'INDEX_OMISSION', path, message: 'Concept missing from index.md' });
  for (const page of published) if (!entities.some(e => e.promotedPageId === page.pageId))
    issues.push({ category: 'structure', code: 'ORPHAN_CONCEPT', path: page.filePath, message: `Published concept has no host: ${page.pageId}` });
  return issues;
}
const assertions = (vaultId: string, db: PrismaClient) => db.vaultAssertion.findMany({ where: { vaultId }, include: { evidence: { where: { vaultId, source: { vaultId } }, include: { source: true } } }, orderBy: { id: 'asc' } });
export async function lintProvenance(vaultId: string, db: PrismaClient): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  for (const a of await assertions(vaultId, db)) {
    if (!a.evidence.length) issues.push({ category: 'provenance', code: 'MISSING_EVIDENCE', assertionIds: [a.id], message: 'Assertion has no source evidence' });
    for (const e of a.evidence) if (/^(?:wiki\/)?answers\/.*\.md$/iu.test(posix.normalize(e.source.filePath.replaceAll('\\', '/'))))
      issues.push({ category: 'provenance', code: 'ANSWER_AS_EVIDENCE', assertionIds: [a.id], sourceIds: [e.sourceId], message: 'Answer page used as source evidence' });
  }
  return issues;
}
function conditions(text: string | null): unknown {
  try { return JSON.parse(text ?? '{}') as unknown; } catch { return text; }
}
const NON_EXCLUSIVE_PREDICATES = new Set(['definition', 'related_to']);
export async function lintConflicts(vaultId: string, db: PrismaClient): Promise<LintIssue[]> {
  const groups = new Map<string, Awaited<ReturnType<typeof assertions>>>();
  const issues: LintIssue[] = [];
  for (const a of await assertions(vaultId, db)) {
    if (a.value === null) continue;
    // definition 值是自由文本释义:不同措辞≠互斥冲突(方案§5.3要求「语义冲突」才报)。只对受域约束的谓词做精确互斥比对。
    if (NON_EXCLUSIVE_PREDICATES.has(a.predicate)) continue;
    const key = canonicalJson([a.subjectId, a.predicate, a.polarity, conditions(a.conditions)]);
    const previous = groups.get(key) ?? [];
    for (const b of previous) if (a.value !== b.value) issues.push({ category: 'conflicts', code: 'CONFLICTING_VALUES',
      assertionIds: [b.id, a.id], sourceIds: [...new Set([...b.evidence, ...a.evidence].map(e => e.sourceId))],
      message: `${b.value} <> ${a.value}; sources: ${b.evidence.map(e => e.sourceId).join(',')} / ${a.evidence.map(e => e.sourceId).join(',')}` });
    previous.push(a); groups.set(key, previous);
  }
  return issues;
}
export async function lintTimeliness(vaultId: string, db: PrismaClient): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  for (const a of await assertions(vaultId, db)) {
    // VaultAssertion has no supersededAt column. Read optional side metadata in conditions JSON.
    const metadata = conditions(a.conditions);
    if (!metadata || typeof metadata !== 'object' || !('supersededAt' in metadata) || typeof metadata.supersededAt !== 'string') continue;
    const supersededAt = Date.parse(metadata.supersededAt);
    if (!Number.isFinite(supersededAt)) continue;
    for (const e of a.evidence) if (e.source.createdAt.getTime() > supersededAt)
      issues.push({ category: 'timeliness', code: 'STALE_INFORMATION', assertionIds: [a.id], sourceIds: [e.sourceId], message: '旧信息用于新版本' });
  }
  return issues;
}
export async function lintVault(vaultPath: string, vaultId: string, db: PrismaClient): Promise<LintReport> {
  const results = await Promise.all([lintStructure(vaultPath, vaultId, db), lintProvenance(vaultId, db), lintConflicts(vaultId, db), lintTimeliness(vaultId, db)]);
  return { vaultId, issues: results.flat() };
}
