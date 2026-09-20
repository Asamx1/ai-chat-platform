import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// 直连 DB 的路由集成测试：mock 掉 better-auth 会话（本测试不覆盖鉴权细节，只覆盖
// 「非本人/无会话 → 404」这条契约）。userId 在用例内注入。
const sessionState: { userId: string | null } = { userId: null };

vi.mock('@/lib/auth', () => ({
  auth: {
    api: {
      getSession: async (_args: { headers: Headers }) =>
        sessionState.userId ? { user: { id: sessionState.userId } } : null,
    },
  },
}));

// eslint-disable-next-line import/first
import { prisma } from '@aichat/db';
// eslint-disable-next-line import/first
import { GET } from '../src/app/api/runs/[runId]/events/route';

const ids: { userId?: string; conversationId?: string; runId?: string } = {};

async function cleanup(): Promise<void> {
  if (ids.runId) await prisma.runEvent.deleteMany({ where: { runId: ids.runId } });
  if (ids.runId) await prisma.orchestrationRun.deleteMany({ where: { id: ids.runId } });
  if (ids.conversationId) await prisma.conversation.deleteMany({ where: { id: ids.conversationId } });
  if (ids.userId) await prisma.user.deleteMany({ where: { id: ids.userId } });
}

/** 读取 Response 的整个流，返回拼接文本（终态事件后路由会关闭流）。 */
async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

beforeAll(async () => {
  const suffix = Date.now() + Math.floor(Math.random() * 1e6);
  const user = await prisma.user.create({
    data: { email: `sse-test-${suffix}@example.com`, passwordHash: 'x' },
  });
  const conversation = await prisma.conversation.create({
    data: { ownerId: user.id, title: 'sse test', type: 'SINGLE' },
  });
  const run = await prisma.orchestrationRun.create({
    data: {
      conversationId: conversation.id,
      ownerId: user.id,
      status: 'RUNNING',
      idempotencyKey: `sse-test-${suffix}`,
      configSnapshot: {},
    },
  });
  await prisma.runEvent.createMany({
    data: [
      { runId: run.id, seq: 1, type: 'run.started', payload: {} },
      { runId: run.id, seq: 2, type: 'run.planning', payload: { round: 0 } },
      { runId: run.id, seq: 3, type: 'run.succeeded', payload: {} },
    ],
  });
  Object.assign(ids, { userId: user.id, conversationId: conversation.id, runId: run.id });
});

afterAll(cleanup);

describe('GET /api/runs/[runId]/events', () => {
  it('无会话 → 404（不进流）', async () => {
    sessionState.userId = null;
    const res = await GET(
      new Request(`http://localhost/api/runs/${ids.runId}/events`),
      { params: Promise.resolve({ runId: ids.runId! }) },
    );
    expect(res.status).toBe(404);
  });

  it('非本人 run → 404', async () => {
    sessionState.userId = 'not-the-owner';
    const res = await GET(
      new Request(`http://localhost/api/runs/${ids.runId}/events`),
      { params: Promise.resolve({ runId: ids.runId! }) },
    );
    expect(res.status).toBe(404);
  });

  it('Last-Event-ID:1 → 只推 seq 2,3；含 id: 行；终态后流结束', async () => {
    sessionState.userId = ids.userId;
    const res = await GET(
      new Request(`http://localhost/api/runs/${ids.runId}/events`, {
        headers: { 'last-event-id': '1' },
      }),
      { params: Promise.resolve({ runId: ids.runId! }) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-store');

    const text = await readAll(res);
    expect(text).toContain('id: 2\n');
    expect(text).toContain('id: 3\n');
    expect(text).not.toContain('id: 1\n');
    expect(text).not.toContain('"run.started"');
    expect(text).toContain('"run.planning"');
    expect(text).toContain('"run.succeeded"');
    // 帧格式：每条事件都有 data: 行，且以空行结尾
    expect(text).toMatch(/id: 3\ndata: \{.*"seq":3.*\}\n\n/);
  });

  it('不存在的 run → 404', async () => {
    sessionState.userId = ids.userId;
    const res = await GET(
      new Request('http://localhost/api/runs/nonexistent/events'),
      { params: Promise.resolve({ runId: 'nonexistent' }) },
    );
    expect(res.status).toBe(404);
  });
});
