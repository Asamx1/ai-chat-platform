import { expect, it, vi } from 'vitest';
const external = vi.hoisted(() => ({ getSession: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: external.getSession } } }));
vi.mock('@aichat/db', () => ({ prisma: { apiKey: external } }));
vi.mock('@aichat/crypto', () => ({ encrypt: vi.fn(), decrypt: vi.fn(), maskKey: vi.fn() }));
import { POST, DELETE } from '../src/app/api/keys/route';
it('rejects invalid origins before session, key mutation or external verification', async () => {
  vi.stubEnv('BETTER_AUTH_URL', 'https://app.example');
  vi.stubEnv('AICHAT_LOCAL_SMOKE', '0');
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  for (const handler of [POST, DELETE]) {
    for (const origin of [undefined, 'null', 'https://evil.example', 'https://app.example/path']) {
      const req = new Request('https://app.example/api/keys?provider=deepseek', { method: 'POST', headers: origin ? { origin } : {} });
      expect((await handler(req)).status).toBe(403);
    }
  }
  expect(fetch).not.toHaveBeenCalled();
  expect(external.getSession).not.toHaveBeenCalled();
  expect(external.upsert).not.toHaveBeenCalled();
  expect(external.deleteMany).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
