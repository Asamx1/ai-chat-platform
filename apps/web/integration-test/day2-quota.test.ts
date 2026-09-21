import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@aichat/db';
import { reserveQuota, finishQuota, lockQuota } from '@aichat/providers/quota';

// Requires the Day2 migration and a disposable integration database.
describe('Day2 PostgreSQL reservations', () => {
  const id = randomUUID();
  const userId = `quota-user-${id}`, modelId = `quota-model-${id}`, providerId = `quota-provider-${id}`;
  let runId: string;
  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${id}@quota.test`, passwordHash: 'test-only' } });
    await prisma.provider.create({ data: { id: providerId, kind: 'fake', baseUrl: 'http://invalid' } });
    await prisma.modelRegistry.create({ data: { id: modelId, providerId, modelKey: 'test', kind: 'cloud', capabilities: {}, pricingVersion: 'test' } });
    const conversation = await prisma.conversation.create({ data: { ownerId: userId, title: 'quota integration', type: 'SINGLE' } });
    runId = (await prisma.orchestrationRun.create({ data: { ownerId: userId, conversationId: conversation.id, idempotencyKey: id, configSnapshot: {} } })).id;
    await prisma.userModelQuota.create({ data: { userId, modelId, dailyLimit: 100 } });
  });
  afterAll(async () => {
    await prisma.usageLog.deleteMany({ where: { userId } });
    await prisma.orchestrationRun.deleteMany({ where: { ownerId: userId } });
    await prisma.conversation.deleteMany({ where: { ownerId: userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.provider.deleteMany({ where: { id: providerId } });
  });
  it('serializes concurrent reservations and settles exactly once on the original UTC date', async () => {
    const base = { userId, modelId, runId, amount: 60, cloud: true, attempt: 0, seatId: 'default', now: new Date('2026-09-21T23:59:59Z') };
    const results = await Promise.all(['a','b'].map(suffix => reserveQuota(prisma, { ...base, requestHash: `${id}-${suffix}` })));
    expect(results.filter(Boolean)).toHaveLength(1);
    const call = results.find(value => value !== null)!;
    const outcome = { tokensIn: 10, tokensOut: 5, text: 'result' };
    await Promise.all([finishQuota(prisma, call, outcome), finishQuota(prisma, call, outcome)]);
    const row = await prisma.modelUsageDaily.findUniqueOrThrow({ where: { userId_modelId_date: { userId, modelId, date: new Date('2026-09-21') } } });
    expect(row).toMatchObject({ tokensIn: 10, tokensOut: 5, reservedTokens: 0 });
    expect(await prisma.usageLog.count({ where: { callId: call.id } })).toBe(1);
  });
  it('quota decreases do not refund in-flight calls; unknown outcomes block replay', async () => {
    const request = { userId, modelId, runId, amount: 40, cloud: true, attempt: 0, seatId: 'default', now: new Date('2026-09-22'), requestHash: `${id}-pending` };
    const call = await reserveQuota(prisma, request);
    expect(call).not.toBeNull();
    await prisma.$transaction(async tx => {
      await lockQuota(tx, userId, modelId);
      await tx.userModelQuota.update({ where: { userId_modelId: { userId, modelId } }, data: { dailyLimit: 0 } });
    });
    await expect(reserveQuota(prisma, request)).rejects.toThrow('QUOTA_CALL_EXISTS');
    expect(await reserveQuota(prisma, { ...request, requestHash: `${id}-denied` })).toBeNull();
    await finishQuota(prisma, call!, { tokensIn: 20, tokensOut: 10, text: 'confirmed' });
    expect(await prisma.modelUsageDaily.findUnique({ where: { userId_modelId_date: { userId, modelId, date: new Date('2026-09-22') } } })).toMatchObject({ reservedTokens: 0, tokensIn: 20, tokensOut: 10 });
  });
});
