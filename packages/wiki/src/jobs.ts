import type { Prisma, PrismaClient } from '@aichat/db';
import { sha256 } from './scan';

export type JobKind = 'scan_backlog' | 'lint_check' | 'reextract' | 'republish';
export const MAX_JOB_ATTEMPTS = 3;
// Canonical JSON makes object key order irrelevant; array order remains significant.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function jobFingerprint(payload: Prisma.InputJsonObject): string {
  // delayUntil is queue metadata, never part of task identity.
  const { delayUntil: _delay, ...identity } = payload;
  return sha256(canonicalJson(identity));
}
export async function enqueueJob(kind: JobKind, payload: Prisma.InputJsonObject, vaultId: string, db: PrismaClient) {
  if (payload.delayUntil !== undefined && (typeof payload.delayUntil !== 'string' || !Number.isFinite(Date.parse(payload.delayUntil)))) throw new Error('INVALID_JOB_DELAY');
  const fingerprint = jobFingerprint(payload);
  try {
    return await db.wikiJob.create({ data: { vaultId, kind, fingerprint, payload } });
  } catch (error) {
    // Concurrent enqueue of the same fingerprint: the winner's row already satisfies the request — return it.
    if ((error as { code?: string }).code === 'P2002') return db.wikiJob.findUniqueOrThrow({ where: { vaultId_kind_fingerprint: { vaultId, kind, fingerprint } } });
    throw error;
  }
}
export async function claimNextJob(vaultId: string, db: PrismaClient, opts: { kind?: JobKind; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  return db.$transaction(async tx => {
    // All claimers for this vault serialize selection and transition in one short transaction.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wiki-jobs:${vaultId}`}, 0))`;
    const pending = await tx.wikiJob.findMany({ where: { vaultId, status: 'pending', attempts: { lt: MAX_JOB_ATTEMPTS }, ...(opts.kind ? { kind: opts.kind } : {}) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const job = pending.find(row => {
      const delay = (row.payload as Record<string, unknown>).delayUntil;
      return delay === undefined || (typeof delay === 'string' && Date.parse(delay) <= now.getTime());
    });
    if (!job) return null;
    const changed = await tx.wikiJob.updateMany({ where: { id: job.id, status: 'pending', attempts: job.attempts }, data: { status: 'running', attempts: { increment: 1 }, startedAt: now, finishedAt: null, error: null } });
    return changed.count ? tx.wikiJob.findUniqueOrThrow({ where: { id: job.id } }) : null;
  });
}
type Claim = { id: string; attempts: number };
export async function completeJob(job: Claim, result: Prisma.InputJsonObject, db: PrismaClient) {
  return db.wikiJob.updateMany({ where: { id: job.id, status: 'running', attempts: job.attempts }, data: { status: 'done', result, error: null, finishedAt: new Date() } });
}
export async function failJob(job: Claim, error: unknown, db: PrismaClient, now = new Date()) {
  return db.$transaction(async tx => {
    const current = await tx.wikiJob.findUniqueOrThrow({ where: { id: job.id } });
    const retry = current.attempts < MAX_JOB_ATTEMPTS;
    const payload = { ...(current.payload as Prisma.InputJsonObject) };
    if (retry) payload.delayUntil = new Date(now.getTime() + 1000 * 2 ** (current.attempts - 1)).toISOString();
    else delete payload.delayUntil;
    return tx.wikiJob.updateMany({ where: { id: job.id, status: 'running', attempts: job.attempts }, data: {
      status: retry ? 'pending' : 'failed', payload, error: error instanceof Error ? error.message : String(error),
      startedAt: retry ? null : current.startedAt, finishedAt: retry ? null : now,
    } });
  });
}
export async function cancelJob(id: string, db: PrismaClient) {
  return db.wikiJob.updateMany({ where: { id, status: { in: ['pending', 'running'] } }, data: { status: 'cancelled', finishedAt: new Date() } });
}
