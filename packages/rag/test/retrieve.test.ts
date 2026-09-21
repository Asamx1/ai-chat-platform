import { expect, it, vi } from 'vitest';
const { query, embedding } = vi.hoisted(() => ({ query: vi.fn().mockResolvedValue([]), embedding: Array(1024).fill(0.1) }));
vi.mock('@aichat/db', () => ({ prisma: { $queryRawUnsafe: query } }));
vi.mock('../src/embed', async importOriginal => ({
  ...await importOriginal<typeof import('../src/embed')>(), embed: vi.fn(async () => [embedding]),
}));
import { retrieve } from '../src/retrieve';
it('binds vector, owner, conversation and model; projects no embedding', async () => {
  const owner = "owner'; DROP TABLE x;--";
  const conversation = "conversation' OR true--";
  await retrieve(owner, conversation, 'query');
  const [sql, vector, user, id, model] = query.mock.calls[0]!;
  expect(sql).not.toContain(owner);
  expect(sql).not.toContain(conversation);
  expect(sql).toContain('k."userId"=$2 AND v."ownerId"=$2');
  expect(sql).toContain("d.status='READY' AND d.model=$4");
  expect(sql).toContain('<=> $1::vector(1024)');
  expect(sql).toContain('LIMIT 5');
  expect(sql).not.toMatch(/SELECT\s+\*|c\.embedding\s*,/);
  expect([vector, user, id, model]).toEqual([JSON.stringify(embedding), owner, conversation, process.env.EMBEDDING_MODEL || 'bge-m3:latest']);
});
