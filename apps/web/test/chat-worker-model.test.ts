import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), findFirst: vi.fn() }));
vi.mock('@aichat/db', () => ({ prisma: {
  modelRegistry: { findUnique: mocks.findUnique, findFirst: mocks.findFirst },
} }));
import { resolveRunProvider } from '../../worker/src/runner';

const row = {
  id: 'registry-id', modelKey: 'qwen3:0.6b', providerId: 'ollama', kind: 'local',
  adapter: null, baseUrl: null, provider: { kind: 'ollama', baseUrl: 'http://localhost:11434' },
};
afterEach(() => vi.unstubAllGlobals());
it.each([row.id, row.modelKey])('worker resolves snapshot identifier %s and sends modelKey to provider', async identifier => {
  mocks.findUnique.mockResolvedValue(identifier === row.id ? row : null);
  mocks.findFirst.mockResolvedValue(row);
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n'));
  vi.stubGlobal('fetch', fetch);
  const resolved = await resolveRunProvider('user', identifier);
  for await (const event of resolved.provider.streamChat([{ role: 'user', content: 'hello' }])) {
    expect(event.type).not.toBe('error');
  }
  expect(JSON.parse(fetch.mock.calls[0]![1].body).model).toBe(row.modelKey);
  expect(resolved.modelKey).toBe(row.id); // Usage accounting keeps the canonical id.
});
