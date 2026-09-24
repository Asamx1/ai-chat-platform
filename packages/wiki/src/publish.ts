import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { PrismaClient } from '@aichat/db';
import { eligiblePromotions, pageSlug, promoteEntity } from './promote';
import { sha256 } from './scan';

export interface PublishOptions { autoGit?: boolean; userId?: string; ontologyVersion?: string; rulesVersion?: string }
export interface PublishReport {
  revision: string; promoted: string[]; pagesWritten: number; files: Array<{ path: string; sha256: string }>;
  baselineHash: string; ontologyVersion: string; gitCommit: string | null; gitSkipped: string | null;
}
export class PublishError extends Error {
  constructor(public readonly stage: string, public readonly revision: string, cause: unknown, public readonly recoveryErrors: string[]) {
    super(`Publish ${revision || '(unallocated)'} failed at ${stage}: ${String(cause)}${recoveryErrors.length ? `; recovery: ${recoveryErrors.join('; ')}` : ''}`, { cause });
  }
}
const exec = promisify(execFile);
const plain = (value: string) => value.replaceAll('[', '&#91;').replaceAll(']', '&#93;').replace(/[\r\n]+/gu, ' ');
const hashes = (files: Map<string, Buffer>) => [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({ path, sha256: sha256(bytes) }));
async function snapshot(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  async function walk(path: string): Promise<void> {
    let entries;
    try { entries = await readdir(resolve(root, path), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const child = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`SYMLINK_IN_WIKI: ${child}`);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.set(child, await readFile(resolve(root, child)));
    }
  }
  // readdir follows a symlink at the root; reject that too.
  const { lstat } = await import('node:fs/promises');
  try { if ((await lstat(resolve(root, 'wiki'))).isSymbolicLink()) throw new Error('SYMLINK_IN_WIKI: wiki'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await walk('wiki');
  return files;
}
async function atomic(root: string, path: string, bytes: Buffer): Promise<void> {
  const file = resolve(root, path);
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, bytes, { flag: 'wx' }); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
}
export function links(text: string): string[] {
  return [...text.matchAll(/\[\[([^\]]+)\]\]/gu)].map(match => match[1]!.split('|')[0]!.split('#')[0]!.replace(/\.md$/u, ''));
}
export async function publishRevision(vaultPath: string, vaultId: string, db: PrismaClient, opts: PublishOptions = {}): Promise<PublishReport> {
  const root = resolve(vaultPath);
  let stage = 'baseline'; let revision = ''; let baselineHash = ''; let ontologyVersion = opts.ontologyVersion ?? 'unknown';
  const rulesVersion = opts.rulesVersion ?? 'unknown';
  let files: PublishReport['files'] = [];
  const recoveryErrors: string[] = [];
  let report: PublishReport;
  let restoreBaseline = new Map<string, Buffer>();
  const written: string[] = [];
  async function restore(): Promise<void> {
    for (const path of written.splice(0).reverse()) {
      try { const old = restoreBaseline.get(path); if (old) await atomic(root, path, old); else await rm(resolve(root, path), { force: true }); }
      catch (recovery) { recoveryErrors.push(`${path}: ${String(recovery)}`); }
    }
  }
  try {
    report = await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wiki-publish:${vaultId}`}, 0))`;
      const releases = await tx.vaultRelease.findMany({ where: { vaultId, status: 'committed' }, select: { revision: true } });
      const maximum = Math.max(0, ...releases.map(r => /^rev-\d+$/u.test(r.revision) ? Number(r.revision.slice(4)) : 0));
      revision = `rev-${String(maximum + 1).padStart(3, '0')}`;
      const baseline = await snapshot(root);
      baselineHash = sha256(JSON.stringify(hashes(baseline)));
      restoreBaseline = baseline;
      try {
        stage = 'stage';
        const promoted: string[] = [];
        for (const item of await eligiblePromotions(vaultId, tx)) promoted.push((await promoteEntity(item.candidate.id, vaultId, tx)).pageId);
        // A single source supports a statement without granting it a concept page.
        await tx.vaultAssertion.updateMany({ where: { vaultId, status: 'candidate', evidence: { some: { vaultId, stance: 'supports', source: { vaultId } } } }, data: { status: 'supported' } });
        const entities = await tx.vaultEntityCandidate.findMany({ where: { vaultId }, orderBy: { id: 'asc' } });
        const assertions = await tx.vaultAssertion.findMany({ where: { vaultId, status: { in: ['supported', 'candidate'] } }, include: { evidence: { where: { vaultId }, include: { source: true } } }, orderBy: { id: 'asc' } });
        const families = await tx.vaultSourceFamily.findMany({ where: { vaultId }, include: { sources: { where: { vaultId }, orderBy: { createdAt: 'asc' } } }, orderBy: { id: 'asc' } });
        const versions = [...new Set(assertions.map(a => a.ontologyVersion))];
        if (!opts.ontologyVersion && versions.length > 1) throw new Error('MIXED_ONTOLOGY_VERSIONS');
        ontologyVersion = opts.ontologyVersion ?? versions[0] ?? 'unknown';
        const names = new Map(entities.map(e => [e.id, e.canonicalName]));
        const statement = (a: typeof assertions[number]) => plain(`${names.get(a.subjectId) ?? a.subjectId} ${a.polarity ? '' : 'NOT '}${a.predicate} ${a.objectId ? names.get(a.objectId) ?? a.objectId : a.value ?? ''}; conditions: ${a.conditions ?? '{}'}`);
        const citation = (a: typeof assertions[number]) => `[${a.id}] ${a.evidence.map(e => {
          const locator = JSON.parse(e.locatorJson) as Record<string, unknown>;
          return `${plain(e.source.title)} (${e.locatorKind === 'page' ? `page ${locator.page ?? locator.pageNumber ?? '?'}` : `${e.locatorKind} ${plain(e.locatorJson)}`}; ${e.sourceSha256}; ${e.stance})`;
        }).join('; ')}`;
        const staged = new Map<string, Buffer>();
        const pages: Array<{ pageId: string; kind: string; title: string; filePath: string }> = [];
        const put = (path: string, text: string) => { if (staged.has(path)) throw new Error(`FILE_COLLISION: ${path}`); staged.set(path, Buffer.from(text)); };
        const retire: string[] = [];
        const stagedPageIds = new Set<string>();
        const publishedPageIds = new Set((await tx.vaultPage.findMany({ where: { vaultId, kind: 'concept' }, select: { pageId: true } })).map(pg => pg.pageId));
        for (const family of families) {
          const slug = pageSlug(family.id);
          const filePath = `wiki/sources/${slug}.md`;
          const related = assertions.filter(a => a.evidence.some(e => e.source.familyId === family.id));
          put(filePath, `# ${plain(family.title)}\n\n${family.sources.map(s => `- ${plain(s.title)}; SHA256: ${s.sha256}; introduced: ${s.createdAt.toISOString()}`).join('\n')}\n\nAssertions: ${related.length}\n\n${related.filter(a => a.status === 'supported').slice(0, 2).map(a => `${statement(a)} ${citation(a)}`).join('\n\n')}\n`);
          pages.push({ pageId: `sources/${slug}`, kind: 'source_summary', title: family.title, filePath });
        }
        for (const entity of entities.filter(e => e.status === 'promoted' && e.type !== 'Source')) {
          const slug = entity.promotedPageId;
          if (!slug || pageSlug(slug) !== slug) throw new Error(`INVALID_PAGE_ID: ${entity.id}`);
          const related = assertions.filter(a => a.subjectId === entity.id || a.objectId === entity.id);
          const supported = related.filter(a => a.status === 'supported');
          const neighbors = entities.filter(e => e.id !== entity.id && (e.status === 'candidate' || e.status === 'promoted') && related.some(a => a.subjectId === e.id || a.objectId === e.id));
          const filePath = `wiki/concepts/${slug}.md`;
          put(filePath, `${supported[0] ? `${statement(supported[0])} ${citation(supported[0])}` : `${plain(entity.canonicalName)}: no supported assertion available.`}\n\n# ${plain(entity.canonicalName)}\n\n## Definition\n\n${supported.map(a => `- ${statement(a)} ${citation(a)}`).join('\n')}\n\n## Relations (navigation only)\n\n${neighbors.map(e => `- [[concepts/${e.promotedPageId ?? pageSlug(e.canonicalName)}|${plain(e.canonicalName)}]]`).join('\n')}\n`);
          pages.push({ pageId: slug, kind: 'concept', title: entity.canonicalName, filePath }); stagedPageIds.add(slug);
        }
        const allPaths = new Set([...baseline.keys(), ...staged.keys()]);
        const conceptPaths = [...allPaths].filter(p => /^wiki\/concepts\/[^/]+\.md$/u.test(p)).sort();
        const marker = /\n<!-- publish:concepts -->[\s\S]*?<!-- \/publish:concepts -->\n?/u;
        const oldIndex = baseline.get('wiki/index.md')?.toString('utf8') ?? '# Wiki\n';
        put('wiki/index.md', `${oldIndex.replace(marker, '').trimEnd()}\n\n<!-- publish:concepts -->\n## Concepts\n${conceptPaths.map(p => `- [[${p.slice(5, -3)}]]`).join('\n')}\n<!-- /publish:concepts -->\n`);
        const oldLog = baseline.get('wiki/log.md')?.toString('utf8') ?? '# Release log\n';
        put('wiki/log.md', `${oldLog}\n\n## ${revision}\n${families.length} sources, ${promoted.length} concepts promoted\n${promoted.map(p => `- ${p}`).join('\n')}\n`);
        stage = 'validate';
        const combined = new Map([...baseline, ...staged]);
        const knownIds = new Set((await tx.vaultAssertion.findMany({ where: { vaultId }, select: { id: true } })).map(a => a.id));
        const candidates = new Set(entities.filter(e => e.status === 'candidate').map(e => `concepts/${pageSlug(e.canonicalName)}`));
        const targets = new Set([...combined.keys()].filter(p => p.endsWith('.md')).map(p => p.slice(5, -3)));
        for (const [path, content] of combined) {
          if (!path.endsWith('.md')) continue;
          const text = content.toString('utf8');
          if (path.startsWith('wiki/concepts/') && staged.has(path)) {
            // Pages (re)written by this batch: stale citations from earlier releases are dropped instead of blocking publication.
            let pageText = text;
            for (const match of [...pageText.matchAll(/\[(asr_[^\]\s]+)\]/gu)]) {
              if (!knownIds.has(match[1]!)) { put(path, pageText = pageText.replaceAll(`[${match[1]!}]`, '').replaceAll(` [${match[1]!}]`, ' ')); combined.set(path, Buffer.from(pageText, 'utf8')); }
            }
          } else if (path.startsWith('wiki/concepts/')) {
            const slug = path.slice('wiki/concepts/'.length, -3);
            const host = entities.some(e => e.promotedPageId === slug) || stagedPageIds.has(slug);
            // Orphaned SYSTEM page: previously published (VaultPage record) but host entity no longer exists (merged/replaced by a reextract) — retire it.
            // Manual pages (never published by us, no live host) still reject unknown assertion IDs to block silent injections.
            if (!host && publishedPageIds.has(slug)) { combined.delete(path); baseline.delete(path); retire.push(path); }
            else for (const match of text.matchAll(/\[(asr_[^\]\s]+)\]/gu)) {
              if (!knownIds.has(match[1]!)) throw new Error(`UNKNOWN_ASSERTION: ${match[1]} in ${path}`);
            }
          }
          for (const target of links(text)) {
            if (!target) continue;
            const relative = posix.normalize(posix.join(posix.dirname(path.slice(5)), target));
            const basenameMatch = [...targets].filter(t => posix.basename(t) === target);
            if (!targets.has(target) && !targets.has(relative) && basenameMatch.length !== 1 && !candidates.has(target)) throw new Error(`BROKEN_LINK: ${path} -> ${target}`);
          }
        }
        const indexed = new Set(links(staged.get('wiki/index.md')!.toString()));
        if (conceptPaths.some(p => !indexed.has(p.slice(5, -3))) || [...indexed].some(p => p.startsWith('concepts/') && !targets.has(p))) throw new Error('INDEX_MISMATCH');
        // The manifest hashes payload files, excluding itself to avoid a recursive hash.
        const payload = hashes(staged);
        put(`wiki/_meta/releases/${revision}.json`, `${JSON.stringify({ revision, ontologyVersion, files: Object.fromEntries(payload.map(f => [f.path, f.sha256])) }, null, 2)}\n`);
        files = hashes(staged);
        stage = 'write';
        if (sha256(JSON.stringify(hashes(await snapshot(root)))) !== baselineHash) throw new Error('BASELINE_CHANGED');
        for (const [path, bytes] of staged) { written.push(path); await atomic(root, path, bytes); }
        for (const file of files) if (sha256(await readFile(resolve(root, file.path))) !== file.sha256) throw new Error(`WRITE_HASH_MISMATCH: ${file.path}`);
        stage = 'persist';
        for (const page of pages) await tx.vaultPage.upsert({ where: { vaultId_pageId: { vaultId, pageId: page.pageId } }, create: { ...page, vaultId, revision, ontologyVersion }, update: { ...page, revision, ontologyVersion } });
        const data = { ontologyVersion, rulesVersion, filesJson: files, baselineHash, status: 'committed', gitCommit: null };
        await tx.vaultRelease.upsert({ where: { vaultId_revision: { vaultId, revision } }, create: { ...data, vaultId, revision }, update: data });
        return { revision, promoted, pagesWritten: pages.length, files, baselineHash, ontologyVersion, gitCommit: null, gitSkipped: null };
      } catch (error) {
        await restore();
        throw error;
      }
    }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    await restore();
    if (revision) {
      try {
        const data = { ontologyVersion, rulesVersion, filesJson: files, baselineHash, status: 'aborted' };
        const existing = await db.vaultRelease.findUnique({ where: { vaultId_revision: { vaultId, revision } } });
        if (!existing) await db.vaultRelease.create({ data: { ...data, vaultId, revision } });
        else if (existing.status === 'aborted') await db.vaultRelease.update({ where: { id: existing.id }, data });
      } catch (recovery) { recoveryErrors.push(`aborted release: ${String(recovery)}`); }
    }
    throw new PublishError(stage, revision, error, recoveryErrors);
  }
  if (opts.autoGit === false) report.gitSkipped = 'autoGit disabled';
  else {
    try {
      await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root });
      await exec('git', ['add', '-A'], { cwd: root });
      const sources = report.files.filter(f => f.path.startsWith('wiki/sources/')).length;
      await exec('git', ['commit', '-m', `${revision}: ${sources} sources, ${report.promoted.length} concepts promoted`], { cwd: root });
      report.gitCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
      await db.vaultRelease.update({ where: { vaultId_revision: { vaultId, revision } }, data: { gitCommit: report.gitCommit } });
    } catch (error) { report.gitSkipped = `Git unavailable or failed after committed publication: ${String(error)}`; }
  }
  return report;
}
