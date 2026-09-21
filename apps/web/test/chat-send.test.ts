import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(), findFirst: vi.fn(), createConversation: vi.fn(), createMessage: vi.fn(),
  runCreate: vi.fn(),
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: async () => ({ user: { id: 'user' } }) } } }));
vi.mock('@aichat/db', () => ({
  prisma: {
    modelRegistry: { findUnique: mocks.findUnique, findFirst: mocks.findFirst },
    apiKey: { findUnique: async () => null },
    orchestrationRun: { findUnique: async () => null, create: mocks.runCreate },
    conversation: { findUnique: async () => ({ id: 'conversation', ownerId: 'user' }) },
  },
  createConversation: mocks.createConversation,
  createMessage: mocks.createMessage,
}));
import { POST } from '../src/app/api/chat/send/route';

function request(modelKey: string) {
  return new Request('http://localhost/api/chat/send', { method: 'POST', body: JSON.stringify({
    conversationId: 'conversation', content: 'hello', modelKey, idempotencyKey: 'request',
  }) });
}

describe('send route through chat-service and real resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue(null);
    mocks.findFirst.mockResolvedValue(null);
  });
  it('preserves UNKNOWN_MODEL as 400 with a readable reason', async () => {
    const response = await POST(request('missing'));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'UNKNOWN_MODEL', error: expect.stringContaining('模型') });
    expect(mocks.createMessage).not.toHaveBeenCalled();
    expect(mocks.runCreate).not.toHaveBeenCalled();
  });
  it('preserves NO_LOCAL_MODEL as 503 with a readable reason', async () => {
    mocks.findUnique.mockResolvedValue({ id: 'cloud-id', modelKey: 'cloud', providerId: 'no-key-provider', kind: 'cloud' });
    const response = await POST(request('cloud-id'));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'NO_LOCAL_MODEL', error: expect.stringContaining('本地回退模型') });
    expect(mocks.createMessage).not.toHaveBeenCalled();
  });
});
