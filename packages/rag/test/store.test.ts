import { beforeEach, expect, it, vi } from 'vitest';
const { tx, transaction } = vi.hoisted(() => {
  const tx = { $queryRawUnsafe: vi.fn(), $executeRawUnsafe: vi.fn() };
  return { tx, transaction: vi.fn(async callback => callback(tx)) };
});
vi.mock('@aichat/db', () => ({ prisma: { $transaction: transaction } }));
import { store } from '../src/store';
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
