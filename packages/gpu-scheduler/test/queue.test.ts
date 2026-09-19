import { describe, expect, it } from 'vitest';
import { RunQueue, waitTimeEstimate } from '../src/index.js';

describe('RunQueue', () => {
  it('dequeues in FIFO order within the same priority', () => {
    const q = new RunQueue();
    q.enqueue('a');
    q.enqueue('b');
    q.enqueue('c');
    expect(q.size).toBe(3);
    expect(q.dequeue()).toBe('a');
    expect(q.dequeue()).toBe('b');
    expect(q.dequeue()).toBe('c');
    expect(q.dequeue()).toBeNull();
    expect(q.size).toBe(0);
  });

  it('lets higher priority entries jump ahead while preserving FIFO ties', () => {
    const q = new RunQueue();
    q.enqueue('low1', 0);
    q.enqueue('low2', 0);
    q.enqueue('high1', 10);
    q.enqueue('high2', 10);
    expect(q.toArray()).toEqual(['high1', 'high2', 'low1', 'low2']);
    expect(q.dequeue()).toBe('high1');
    expect(q.dequeue()).toBe('high2');
    expect(q.dequeue()).toBe('low1');
    expect(q.dequeue()).toBe('low2');
  });

  it('waitTimeEstimate adds 8s only when the model is not loaded', () => {
    expect(waitTimeEstimate(2, true)).toBe(6);
    expect(waitTimeEstimate(2, false)).toBe(14);
  });
});
