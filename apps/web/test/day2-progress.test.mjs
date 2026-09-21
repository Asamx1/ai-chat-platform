import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialProgress, reduceProgress } from '../src/components/collab/run-progress.ts';
import { adminRequest } from '../src/components/admin/api.ts';

const event = (seq, type, payload = {}) => ({ seq, type, payload });
test('replay deduplicates seq and advances only on explicit stage events', () => {
  const running = reduceProgress(initialProgress, event(1, 'collab.seat.started', { seatId: 'a' }));
  assert.equal(running.stage, undefined);
  assert.equal(running.participants.a.status, 'running');
  assert.equal(reduceProgress(running, event(1, 'collab.seat.completed', { seatId: 'a' })), running);
  const round = reduceProgress(running, event(2, 'stage.changed', { stage: 'ROUND', round: 2 }));
  assert.equal(round.stage, 'ROUND');
  assert.equal(round.round, 2);
  assert.deepEqual(round.visited, ['ROUND']);
  const completed = reduceProgress(round, event(3, 'collab.seat.completed', { seatId: 'a' }));
  assert.equal(completed.participants.a.status, 'completed');
  assert.equal(Object.keys(completed.participants).length, 1);
});
test('substitution accepts actual from/to and legacy seat keys', () => {
  for (const payload of [{ from: 'a', to: 'b' }, { fromSeatId: 'a', toSeatId: 'b' }]) {
    const state = reduceProgress(initialProgress, event(1, 'collab.seat.substituted', payload));
    assert.equal(state.participants.a.replacement, 'b');
    assert.equal(state.participants.a.status, 'ended');
    assert.equal(state.participants.b.status, 'waiting');
  }
});
test('degradation persists across completion', () => {
  const degraded = reduceProgress(initialProgress, event(1, 'collab.degraded', { seatId: 'a', reason: 'timeout' }));
  const completed = reduceProgress(degraded, event(2, 'collab.seat.completed', { seatId: 'a' }));
  assert.equal(completed.participants.a.degraded, 'timeout');
});
test('failed attempts can recover before stream.end', () => {
  const failed = reduceProgress(initialProgress, event(1, 'run.failed'));
  assert.equal(failed.ended, false);
  const succeeded = reduceProgress(failed, event(2, 'run.succeeded'));
  assert.equal(succeeded.ended, true);
  assert.equal(succeeded.outcome, '已完成');
  assert.equal(reduceProgress(failed, { type: 'stream.end' }).outcome, '运行失败');
});
test('missing final events are explicit and unfinished seats stop running', () => {
  const running = reduceProgress(initialProgress, event(1, 'seat.started', { seatId: 'a' }));
  const ended = reduceProgress(running, { type: 'stream.end' });
  assert.equal(ended.outcome, '已结束、详情缺失');
  assert.equal(ended.participants.a.status, 'ended');
  assert.equal(reduceProgress(running, event(2, 'run.cancelled')).outcome, '已取消');
  assert.equal(initialProgress.participants.a, undefined);
});
test('admin requests preserve methods, payloads, no-store, 204 and API errors', async () => {
  const original = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (...args) => { calls.push(args); return new Response(null, { status: 204 }); };
    assert.equal(await adminRequest('/quotas/u/m', { method: 'DELETE' }), undefined);
    assert.equal(calls[0][0], '/api/admin/quotas/u/m');
    assert.equal(calls[0][1].method, 'DELETE');
    assert.equal(calls[0][1].cache, 'no-store');
    globalThis.fetch = async (...args) => { calls.push(args); return Response.json({ user: { id: 'u' } }); };
    assert.deepEqual(await adminRequest('/users/u', { method: 'PATCH', body: JSON.stringify({ disabled: true }) }), { user: { id: 'u' } });
    assert.equal(calls[1][1].body, '{"disabled":true}');
    globalThis.fetch = async () => Response.json({ error: 'LAST_ADMIN' }, { status: 409 });
    await assert.rejects(adminRequest('/users/u'), /LAST_ADMIN/);
    globalThis.fetch = async () => new Response('Not Found', { status: 404 });
    await assert.rejects(adminRequest('/usage'), /HTTP 404/);
  } finally { globalThis.fetch = original; }
});
