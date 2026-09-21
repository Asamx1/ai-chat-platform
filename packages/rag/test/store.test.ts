import { beforeEach, expect, it, vi } from 'vitest';
const { tx, transaction } = vi.hoisted(() => {
  const tx = { $queryRawUnsafe: vi.fn(), $executeRawUnsafe: vi.fn() };
  return { tx, transaction: vi.fn(async callback => callback(tx)) };
});
vi.mock('@aichat/db', () => ({ prisma: { $transaction: transaction } }));
import { mergeHits, store, type ChildHit, type ParentRow } from '../src/store';
const slices = [{ ordinal: 0, start: 0, end: 1, text: "'payload" }];
const vectors = [Array(1024).fill(1)];
beforeEach(() => { vi.clearAllMocks(); tx.$queryRawUnsafe.mockResolvedValue([{ id: 'doc' }]); tx.$executeRawUnsafe.mockResolvedValue(1); });
it('locks before replacement and binds text/vector inside one transaction', async () => {
  await store('doc', 2, 'worker', slices, vectors);
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(tx.$queryRawUnsafe.mock.calls[0]![0]).toContain('FOR UPDATE');
  const calls = tx.$executeRawUnsafe.mock.calls;
  expect(calls[0]![0]).toContain('DELETE');
  expect(calls[1]![0]).toContain('$7::vector(1024)');
  expect(calls[1]![0]).not.toContain(slices[0]!.text);
  expect(calls[1]!.slice(-2)).toEqual([slices[0]!.text, JSON.stringify(vectors[0])]);
  expect(calls[2]![0]).toContain('"leaseExpiresAt">clock_timestamp()');
});
it('abandons missing/deleted/lost leases before mutation', async () => {
  tx.$queryRawUnsafe.mockResolvedValue([]);
  await expect(store('doc', 1, 'worker', slices, vectors)).rejects.toThrow('LEASE_LOST');
  expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
});
it('throws to roll back if lease expires during insertion', async () => {
  tx.$executeRawUnsafe.mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(0);
  await expect(store('doc', 1, 'worker', slices, vectors)).rejects.toThrow('LEASE_LOST');
});

// small-to-big: merge / dedupe / budget-trim branches of mergeHits.
const hit = (chunkId: string, parentId: string | null, distance: number, text = `child-${chunkId}`): ChildHit =>
  ({ chunkId, documentId: 'doc', ordinal: 1, name: 'doc.md', text, parentId, distance });
const parentRow = (id: string, text: string): ParentRow => ({ id, documentId: 'doc', ordinal: 0, name: 'doc.md', text });
it('merges child hits sharing a parent, keeping rank order and the best distance', () => {
  const out = mergeHits(
    [hit('c1', 'p1', 0.2), hit('c2', 'p1', 0.1), hit('c3', null, 0.5), hit('c4', null, 0.3)],
    new Map([['p1', parentRow('p1', 'parent text')]]),
    1_000_000,
  );
  expect(out.map(h => h.chunkId)).toEqual(['p1', 'c3', 'c4']); // input rank order preserved
  expect(out[0]).toMatchObject({ text: 'parent text', distance: 0.1, matchedChildIds: ['c1', 'c2'], truncated: false });
  expect(out[1]).toMatchObject({ chunkId: 'c3', text: 'child-c3', matchedChildIds: ['c3'] });
});
it('keeps the child as-is when the parent row is missing or unauthorized', () => {
  const out = mergeHits([hit('c1', 'p-gone', 0.4)], new Map(), 1_000_000);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ chunkId: 'c1', text: 'child-c1', parentId: 'p-gone' });
});
it('truncates the overflowing group in place and drops everything after it', () => {
  const out = mergeHits(
    [hit('c1', 'p1', 0.1), hit('c3', null, 0.2, 'x'.repeat(10))],
    new Map([['p1', parentRow('p1', 'αβγδ')]]), // 8 UTF-8 bytes
    10,
  );
  expect(out).toHaveLength(2);
  expect(out[0]).toMatchObject({ text: 'αβγδ', truncated: false }); // fits exactly (8 <= 10)
  const trimmed = out[1]!;
  expect(trimmed.truncated).toBe(true);
  expect(Buffer.byteLength(trimmed.text, 'utf8')).toBe(2); // only 2 of the 10 bytes remain
  expect(trimmed.text).toBe('xx');
});
it('drops all overflow groups when the budget is already exhausted', () => {
  const out = mergeHits([hit('c1', 'p1', 0.1), hit('c3', null, 0.2)], new Map([['p1', parentRow('p1', 'abcdef')]]), 3);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ text: 'abc', truncated: true });
});
