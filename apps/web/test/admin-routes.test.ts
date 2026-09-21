import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => {
  const db: any = {
    user: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn() },
    session: { deleteMany: vi.fn() },
    modelRegistry: { findUnique: vi.fn(), findMany: vi.fn() },
    userModelQuota: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    $queryRaw: vi.fn(), $queryRawUnsafe: vi.fn(), $executeRawUnsafe: vi.fn(), $transaction: vi.fn(),
  };
  return { db, getSession: vi.fn() };
});
vi.mock('@aichat/db', () => ({ prisma: mocks.db }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
import { GET as users } from '../src/app/api/admin/users/route';
import { PATCH } from '../src/app/api/admin/users/[id]/route';
import { GET as quotas } from '../src/app/api/admin/quotas/route';
import { PUT, DELETE } from '../src/app/api/admin/quotas/[userId]/[modelId]/route';
import { GET as usage } from '../src/app/api/admin/usage/route';
const admin = { id: 'admin', email: 'a@example.com', role: 'ADMIN', disabled: false };
const context = { params: Promise.resolve({ userId: 'u', modelId: 'm' }) };
function request(path: string, method = 'GET', body?: unknown, origin = 'https://app.example') {
  return new Request(`https://app.example/api/admin/${path}`, {
    method, headers: { origin, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('BETTER_AUTH_URL', 'https://app.example');
  vi.stubEnv('AICHAT_LOCAL_SMOKE', '0');
  mocks.getSession.mockResolvedValue({ user: admin });
  mocks.db.user.findUnique.mockResolvedValue(admin);
  mocks.db.user.findMany.mockResolvedValue([]);
  mocks.db.user.count.mockResolvedValue(2);
  mocks.db.user.update.mockResolvedValue({ ...admin, id: 'u', role: 'USER' });
  mocks.db.modelRegistry.findUnique.mockResolvedValue({ id: 'm' });
  mocks.db.modelRegistry.findMany.mockResolvedValue([{ id: 'm' }, { id: 'n' }]);
  mocks.db.userModelQuota.findMany.mockResolvedValue([{ modelId: 'm', dailyLimit: 0 }]);
  mocks.db.userModelQuota.upsert.mockImplementation(async ({ create }: any) => create);
  mocks.db.$queryRaw.mockResolvedValue([]);
  mocks.db.$transaction.mockImplementation((fn: any) => fn(mocks.db));
});
describe('admin API authorization', () => {
  const routes = [
    () => users(request('users')),
    () => PATCH(request('users/u', 'PATCH', { disabled: true }), { params: Promise.resolve({ id: 'u' }) }),
    () => quotas(request('quotas?userId=u')),
    () => PUT(request('quotas/u/m', 'PUT', { dailyLimit: 0 }), context),
    () => DELETE(request('quotas/u/m', 'DELETE'), context),
    () => usage(request('usage?from=2026-09-01&to=2026-09-02')),
  ];
  it.each(routes)('returns uncached 401 for anonymous requests', async route => {
    mocks.getSession.mockResolvedValue(null);
    const response = await route();
    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it.each(routes)('rejects non-admin and disabled database users', async route => {
    mocks.db.user.findUnique.mockResolvedValue({ ...admin, disabled: true });
    expect((await route()).status).toBe(403);
    mocks.db.user.findUnique.mockResolvedValue(admin);
    mocks.getSession.mockResolvedValue({ user: { ...admin, role: 'USER' } });
    expect((await route()).status).toBe(403);
  });
  it('rejects writes with missing/null/cross-origin origins before transaction', async () => {
    for (const origin of ['', 'null', 'https://evil.example', 'https://app.example/path']) {
      expect((await PUT(request('quotas/u/m', 'PUT', { dailyLimit: 1 }, origin), context)).status).toBe(403);
    }
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });
});
describe('admin contracts', () => {
  it('paginates by id without exposing password/key fields', async () => {
    mocks.db.user.findMany.mockResolvedValue([admin, { ...admin, id: 'z' }]);
    expect(await (await users(request('users?limit=1&q=example&cursor=0'))).json()).toEqual({ users: [admin], nextCursor: 'admin' });
    expect(mocks.db.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2, orderBy: { id: 'asc' }, select: { id: true, email: true, role: true, disabled: true } }));
    expect((await users(request('users?limit=101'))).status).toBe(400);
  });
  it('includes models with no override and preserves zero', async () => {
    expect(await (await quotas(request('quotas?userId=u'))).json()).toEqual({ items: [
      { modelId: 'm', dailyLimit: 0, effectiveLimit: 0, source: 'override' },
      { modelId: 'n', dailyLimit: null, effectiveLimit: 200000, source: 'default' },
    ] });
  });
  it.each([-1, 1.1, 2147483648, '10', null])('rejects invalid quota %s', async dailyLimit => {
    expect((await PUT(request('quotas/u/m', 'PUT', { dailyLimit }), context)).status).toBe(400);
    expect(mocks.db.userModelQuota.upsert).not.toHaveBeenCalled();
  });
  it('locks quota writes and supports upsert zero and idempotent delete', async () => {
    expect((await PUT(request('quotas/u/m', 'PUT', { dailyLimit: 0 }), context)).status).toBe(200);
    expect(mocks.db.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), JSON.stringify(['u', 'm']));
    expect((await DELETE(request('quotas/u/m', 'DELETE'), context)).status).toBe(204);
  });
  it('returns 404 for missing quota user/model', async () => {
    mocks.db.modelRegistry.findUnique.mockResolvedValue(null);
    expect((await PUT(request('quotas/u/m', 'PUT', { dailyLimit: 1 }), context)).status).toBe(404);
  });
  it('blocks self-disable/self-demotion and the last effective admin', async () => {
    for (const body of [{ disabled: true }, { role: 'USER' }]) {
      expect((await PATCH(request('users/admin', 'PATCH', body), { params: Promise.resolve({ id: 'admin' }) })).status).toBe(409);
    }
    mocks.db.user.findUnique.mockResolvedValueOnce(admin).mockResolvedValueOnce(admin).mockResolvedValueOnce({ ...admin, id: 'u' });
    mocks.db.user.count.mockResolvedValue(1);
    const response = await PATCH(request('users/u', 'PATCH', { role: 'USER' }), { params: Promise.resolve({ id: 'u' }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'LAST_ADMIN' });
    expect(mocks.db.user.update).not.toHaveBeenCalled();
  });
  it('locks administrators before updating and revokes target sessions', async () => {
    expect((await PATCH(request('users/u', 'PATCH', { role: 'USER' }), { params: Promise.resolve({ id: 'u' }) })).status).toBe(200);
    expect(mocks.db.$queryRaw.mock.calls[1][0].join('')).toContain('FOR UPDATE');
    expect(mocks.db.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u' } });
  });
  it('uses a half-open UTC date range and decimal token strings', async () => {
    mocks.db.$queryRaw.mockResolvedValue([{ date: new Date('2026-09-01Z'), userId: 'u', modelId: 'm', tokens: 4294967294n }]);
    const response = await usage(request('usage?from=2026-09-01&to=2026-10-02'));
    expect(response.status).toBe(200);
    expect((await response.json()).rows[0].tokens).toBe('4294967294');
    const sql = mocks.db.$queryRaw.mock.calls[0][0].join('?');
    expect(sql).toContain('date >=');
    expect(sql).toContain('date <');
    expect(sql).not.toContain('reservedTokens');
    for (const range of ['from=2026-02-30&to=2026-03-01', 'from=2026-09-01&to=2026-10-03', 'from=2026-09-01&to=2026-09-01']) {
      expect((await usage(request(`usage?${range}`))).status).toBe(400);
    }
  });
});
