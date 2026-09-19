/**
 * In-memory priority run queue. Higher priority dequeues first;
 * same priority is FIFO. Pure logic, no persistence.
 */

interface QueueEntry {
  runId: string;
  priority: number;
  seq: number;
}

const SECONDS_PER_POSITION = 3;
const MODEL_LOAD_SECONDS = 8;

export class RunQueue {
  private entries: QueueEntry[] = [];
  private nextSeq = 0;

  enqueue(runId: string, priority = 0): void {
    this.entries.push({ runId, priority, seq: this.nextSeq++ });
  }

  dequeue(): string | null {
    if (this.entries.length === 0) return null;
    let best = 0;
    for (let i = 1; i < this.entries.length; i++) {
      const { priority, seq } = this.entries[i]!;
      const b = this.entries[best]!;
      if (priority > b.priority || (priority === b.priority && seq < b.seq)) {
        best = i;
      }
    }
    return this.entries.splice(best, 1)[0]!.runId;
  }

  get size(): number {
    return this.entries.length;
  }

  toArray(): string[] {
    return [...this.entries]
      .sort(
        (a, b) => b.priority - a.priority || a.seq - b.seq,
      )
      .map((e) => e.runId);
  }
}

/** Rough wait estimate: position * 3s + 8s when the model still needs loading. */
export function waitTimeEstimate(position: number, modelLoaded: boolean): number {
  return position * SECONDS_PER_POSITION + (modelLoaded ? 0 : MODEL_LOAD_SECONDS);
}
