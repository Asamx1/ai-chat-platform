import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => {
  const db: any = {
    user: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn() },
    session: { deleteMany: vi.fn() },
    modelRegistry: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    apiKey: { findMany: vi.fn() },
    modelUsageDaily: { findMany: vi.fn() },
    orchestrationRun: { findMany: vi.fn() },
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
import { GET as publicModels } from '../src/app/api/models/route';
import { GET as models } from '../src/app/api/admin/models/route';
import { PATCH as patchModel } from '../src/app/api/admin/models/[id]/route';
import { GET as runs } from '../src/app/api/admin/runs/route';
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
    () => models(),
    () => runs(),
    () => patchModel(request('models/m', 'PATCH', { available: false }), { params: Promise.resolve({ id: 'm' }) }),
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


const registry = { id: 'm', modelKey: 'local-model', providerId: 'ollama', kind: 'local', capabilities: { label: 'Model', contextWindow: 8192 } };
const modelContext = { params: Promise.resolve({ id: 'm' }) };
describe('admin model registry', () => {
  beforeEach(() => {
    mocks.db.modelRegistry.findUnique.mockResolvedValue(registry);
    mocks.db.modelRegistry.update.mockImplementation(async ({ data }: any) => ({ ...registry, ...data }));
  });
  it('lists disabled models and only exposes registry fields with database IDs', async () => {
    mocks.db.modelRegistry.findMany.mockResolvedValue([registry, { ...registry, id: 'n', capabilities: { available: false } }]);
    const response = await models();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ models: [
      { id: 'm', modelKey: 'local-model', provider: 'ollama', kind: 'local', label: 'Model', available: true },
      { id: 'n', modelKey: 'local-model', provider: 'ollama', kind: 'local', label: 'local-model', available: false },
    ] });
    expect(mocks.db.modelRegistry.findMany).toHaveBeenCalledWith({
      select: { id: true, modelKey: true, kind: true, providerId: true, capabilities: true },
      orderBy: [{ modelKey: 'asc' }, { id: 'asc' }],
    });
  });
  it.each([{ available: false }, { available: true }, { label: ' New label ' }, { label: 'New', available: false }])('updates registry fields and preserves capabilities: %j', async body => {
    const response = await patchModel(request('models/m', 'PATCH', body), modelContext);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const patch = { ...body, ...('label' in body ? { label: body.label.trim() } : {}) };
    expect(mocks.db.$queryRaw.mock.calls[0][0].join('?')).toContain('WHERE id = ? FOR UPDATE');
    expect(mocks.db.$queryRaw.mock.calls[0][1]).toBe('m');
    expect(mocks.db.modelRegistry.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'm' }, data: { capabilities: { ...registry.capabilities, ...patch } },
    }));
    expect((await response.json()).model).toMatchObject(patch);
  });
  it.each([{}, null, [], { label: '' }, { label: '   ' }, { label: 'x'.repeat(201) }, { label: 42 }, { available: 'false' }, { available: null }, { provider: 'other' }, { available: true, extra: 1 }])('rejects invalid patch: %j', async body => {
    expect((await patchModel(request('models/m', 'PATCH', body), modelContext)).status).toBe(400);
    expect(mocks.db.modelRegistry.update).not.toHaveBeenCalled();
  });
  it('rejects malformed JSON', async () => {
    const req = new Request('https://app.example/api/admin/models/m', { method: 'PATCH', headers: { origin: 'https://app.example', 'Content-Type': 'application/json' }, body: '{' });
    expect((await patchModel(req, modelContext)).status).toBe(400);
  });
  it('rejects missing and cross-origin writes before reading the model', async () => {
    for (const origin of ['', 'null', 'https://evil.example']) {
      expect((await patchModel(request('models/m', 'PATCH', { available: false }, origin), modelContext)).status).toBe(403);
    }
    expect(mocks.db.modelRegistry.findUnique).not.toHaveBeenCalled();
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });
  it('returns 404 for missing registry ID', async () => {
    mocks.db.modelRegistry.findUnique.mockResolvedValue(null);
    expect((await patchModel(request('models/m', 'PATCH', { available: false }), modelContext)).status).toBe(404);
    expect(mocks.db.modelRegistry.update).not.toHaveBeenCalled();
  });
});

describe('admin runs monitor', () => {
  const createdAt = new Date('2026-09-01T00:00:00Z');
  const updatedAt = new Date('2026-09-01T00:00:10Z');
  const run = { id: 'r', status: 'SUCCEEDED', createdAt, updatedAt, conversation: { type: 'DEBATE' }, events: [] };
  it('requests the latest 50 across users with a deterministic order and narrow projection', async () => {
    mocks.db.orchestrationRun.findMany.mockResolvedValue([run]);
    const response = await runs();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ runs: [{ id: 'r', type: 'DEBATE', status: 'COMPLETE', durationMs: 10000, createdAt: createdAt.toISOString(), error: null }] });
    expect(mocks.db.orchestrationRun.findMany).toHaveBeenCalledWith({
      take: 50, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true, status: true, createdAt: true, updatedAt: true, conversation: { select: { type: true } },
        events: { where: { type: { in: ['run.succeeded', 'run.failed', 'run.cancelled'] } }, orderBy: { seq: 'desc' }, take: 1, select: { type: true, payload: true, createdAt: true } },
      },
    });
  });
  it('uses terminal event time and exposes failure error', async () => {
    mocks.db.orchestrationRun.findMany.mockResolvedValue([{ ...run, status: 'FAILED', events: [{ type: 'run.failed', payload: { error: 'provider timeout' }, createdAt: new Date(createdAt.getTime() + 2500) }] }]);
    expect((await (await runs()).json()).runs[0]).toMatchObject({ status: 'FAILED', durationMs: 2500, error: 'provider timeout' });
  });
  it.each(['RUNNING', 'PENDING'])('computes elapsed time for %s without showing prior attempt errors', async status => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(createdAt.getTime() + 20000);
    try {
      mocks.db.orchestrationRun.findMany.mockResolvedValue([{ ...run, status, events: [{ type: 'run.failed', payload: { error: 'old attempt' }, createdAt: updatedAt }] }]);
      expect((await (await runs()).json()).runs[0]).toMatchObject({ status, durationMs: 20000, error: null });
    } finally { clock.mockRestore(); }
  });
  it('keeps cancelled status and handles missing error payloads', async () => {
    mocks.db.orchestrationRun.findMany.mockResolvedValue([{ ...run, status: 'CANCELLED' }, { ...run, id: 'f', status: 'FAILED', events: [{ type: 'run.failed', payload: null, createdAt: updatedAt }] }]);
    const data = await (await runs()).json();
    expect(data.runs[0]).toMatchObject({ status: 'CANCELLED', error: null });
    expect(data.runs[1]).toMatchObject({ status: 'FAILED', error: null });
  });
  it('returns an empty list', async () => {
    mocks.db.orchestrationRun.findMany.mockResolvedValue([]);
    expect(await (await runs()).json()).toEqual({ runs: [] });
  });
});


describe('public model availability integration', () => {
  it('honors the registry switch while preserving modelKey IDs and provider gating', async () => {
    mocks.db.apiKey.findMany.mockResolvedValue([]);
    mocks.db.modelUsageDaily.findMany.mockResolvedValue([]);
    mocks.db.modelRegistry.findMany.mockResolvedValue([
      { ...registry, provider: { enabled: true } },
      { ...registry, id: 'off', modelKey: 'disabled-model', capabilities: { available: false }, provider: { enabled: true } },
      { ...registry, id: 'provider-off', modelKey: 'provider-disabled', provider: { enabled: false } },
    ]);
    const data = await (await publicModels()).json();
    expect(data.models[0]).toMatchObject({ id: 'local-model', label: 'Model', available: true });
    expect(data.models[1]).toMatchObject({ id: 'disabled-model', available: false });
    expect(data.models[2]).toMatchObject({ id: 'provider-disabled', available: false });
  });
});
