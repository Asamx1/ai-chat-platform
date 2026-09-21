'use client';
import { useEffect, useState } from 'react';
import { initialProgress, reduceProgress, type ProgressEvent, type RunUsage } from './run-progress';

export function useRunProgress(runId: string) {
  const [state, setState] = useState(initialProgress);
  const [usage, setUsage] = useState<RunUsage | null>(null);
  const [stale, setStale] = useState(false);
  const [connection, setConnection] = useState('加载事件…');
  useEffect(() => {
    let current = initialProgress;
    let disposed = false;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let polling: ReturnType<typeof setInterval> | undefined;
    let usageTimer: ReturnType<typeof setInterval> | undefined;
    let failures = 0;
    let replayBusy = false;
    let usageBusy = false;
    let usageAgain = false;
    const controller = new AbortController();
    const base = `/api/runs/${encodeURIComponent(runId)}`;
    setState(initialProgress); setUsage(null); setStale(false); setConnection('加载事件…');
    async function refreshUsage() {
      if (usageBusy) { usageAgain = true; return; }
      usageBusy = true;
      try {
        const response = await fetch(`${base}/usage`, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json() as RunUsage;
        if (!disposed) { setUsage(body); setStale(false); }
      } catch { if (!disposed) setStale(true); }
      finally {
        usageBusy = false;
        if (usageAgain && !disposed) { usageAgain = false; void refreshUsage(); }
      }
    }
    function stop() {
      source?.close(); source = null;
      clearTimeout(retry); clearInterval(polling); clearInterval(usageTimer);
      polling = undefined;
    }
    function apply(event: ProgressEvent) {
      if (disposed) return;
      const previous = current;
      current = reduceProgress(current, event);
      setState(current);
      if (current !== previous && event.type.includes('usage')) void refreshUsage();
      if (current.ended && !previous.ended) { stop(); setConnection('事件流已结束'); void refreshUsage(); }
    }
    async function replay() {
      if (replayBusy || disposed || current.ended) return;
      replayBusy = true;
      try {
        const response = await fetch(`${base}/events?format=json&after=${current.maxSeq}`, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json() as { events: ProgressEvent[]; run?: { status: string } };
        if (disposed) return;
        for (const event of body.events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) apply(event);
        if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(body.run?.status ?? '') && !current.ended) apply({ type: 'stream.end' });
      } finally { replayBusy = false; }
    }
    function scheduleReconnect() {
      if (disposed || current.ended) return;
      failures += 1;
      setConnection(failures >= 4 ? '连接中断，使用增量轮询' : '连接中断，正在重连…');
      if (failures >= 4 && !polling) polling = setInterval(() => { void replay().catch(() => { if (!disposed) setConnection('事件请求失败，继续重试…'); }); }, 2000);
      clearTimeout(retry);
      retry = setTimeout(connect, [1000, 2000, 5000, 10000][Math.min(failures - 1, 3)]);
    }
    function connect() {
      if (disposed || current.ended) return;
      // Explicit reconnect carries the last applied SSE id through the server's equivalent after cursor.
      source = new EventSource(`${base}/events?after=${current.maxSeq}`);
      source.onopen = () => { if (!disposed) setConnection('已连接，等待事件…'); };
      source.onmessage = message => {
        try {
          const event = JSON.parse(message.data) as ProgressEvent;
          if (event.seq == null && message.lastEventId && event.type !== 'stream.end') event.seq = Number(message.lastEventId);
          apply(event);
          failures = 0; clearInterval(polling); polling = undefined;
          if (!disposed && !current.ended) setConnection('实时更新');
        } catch { source?.close(); scheduleReconnect(); }
      };
      source.onerror = () => { source?.close(); source = null; scheduleReconnect(); };
    }
    usageTimer = setInterval(() => void refreshUsage(), 5000);
    void refreshUsage();
    void replay().then(() => connect()).catch(() => scheduleReconnect());
    return () => { disposed = true; stop(); controller.abort(); };
  }, [runId]);
  return { state, usage, stale, connection };
}
