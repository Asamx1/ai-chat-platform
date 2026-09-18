#!/usr/bin/env node
/**
 * M1 验收压测（kimi P5 TC-02/TC-01 的 API 层实现）：
 *  1) SSE 断线重连 N 次：Last-Event-ID 续传，事件不重不丢
 *  2) 双用户并发串流污染：各自 runId 隔离，事件归属正确
 * 用法：node tests/m1-acceptance.mjs [reconnectRounds]（默认 30，验收全量 100）
 * 前置：dev server :3100 + seed 完成 + Ollama qwen3:0.6b
 */
const BASE = process.env.WEB_BASE_URL || 'http://127.0.0.1:3100';

async function signIn(email, password) {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`sign-in ${email} failed: ${res.status}`);
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

async function sendMsg(cookie, content, idem) {
  const res = await fetch(`${BASE}/api/chat/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, cookie },
    body: JSON.stringify({ content, modelKey: 'qwen3:0.6b', idempotencyKey: idem }),
  });
  if (!res.ok) throw new Error(`send failed ${res.status}: ${await res.text()}`);
  return res.json();
}

/** 收集 SSE 事件直到终态或 abort。返回 {events, lastSeq}。 */
async function collectSSE(cookie, runId, { after = 0, signal } = {}) {
  const events = [];
  let res;
  try {
    res = await fetch(`${BASE}/api/runs/${runId}/events?after=${after}`, {
      headers: { cookie, origin: BASE, ...(after ? { 'last-event-id': String(after) } : {}) },
      signal,
    });
  } catch (e) {
    if (signal?.aborted) return { events, lastSeq: after, aborted: true };
    throw e;
  }
  if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let lastSeq = after;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue; // heartbeat 注释行
        try {
          const evt = JSON.parse(dataLine.slice(5));
          events.push(evt);
          if (typeof evt.seq === 'number') lastSeq = evt.seq;
          if (/run\.(succeeded|failed|cancelled)/.test(evt.type)) return { events, lastSeq };
        } catch {}
      }
    }
  } catch (e) {
    if (signal?.aborted) return { events, lastSeq, aborted: true };
    throw e;
  }
  return { events, lastSeq };
}

async function main() {
  const rounds = Number(process.argv[2] || 30);
  let failures = 0;
  const check = (label, ok, detail = '') => {
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
  };

  const admin = await signIn('admin@example.com', 'admin12345');
  const demo = await signIn('demo@example.com', 'demo12345');

  // ── 压测 1：SSE 断线重连（TC-02 缩减版）──
  console.log(`\n== SSE reconnect stress: ${rounds} rounds ==`);
  const stamp = Date.now();
  const { runId } = await sendMsg(admin, `压测消息 ${stamp}，请用一句话回答`, `stress-${stamp}`);
  let got = [];
  let lastSeq = 0;
  const expectedTerminal = new Set();
  for (let i = 0; i < rounds; i++) {
    const ctl = new AbortController();
    const killAt = 300 + Math.floor(Math.random() * 700); // 0.3-1.0s 随机断
    const timer = setTimeout(() => ctl.abort(), killAt);
    const { events, lastSeq: seq, aborted } = await collectSSE(admin, runId, { after: lastSeq, signal: ctl.signal });
    clearTimeout(timer);
    got = got.concat(events.filter((e) => !/heartbeat/.test(e.type)));
    lastSeq = Math.max(lastSeq, seq);
    const terminal = events.some((e) => /run\.(succeeded|failed|cancelled)/.test(e.type));
    if (terminal) {
      expectedTerminal.add(1);
      break;
    }
    if (!aborted && i < rounds - 1) {
      // 连接自然结束但没终态：算一轮重连
    }
    await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
  }
  // 完整收尾（若尚未终态）
  if (!expectedTerminal.size) {
    const { events } = await collectSSE(admin, runId, { after: lastSeq });
    got = got.concat(events);
  }
  // 校验：seq 连续、无重复、无丢失
  const seqs = got.filter((e) => typeof e.seq === 'number').map((e) => e.seq);
  const dup = seqs.length - new Set(seqs).size;
  const missing = [];
  if (seqs.length) {
    for (let s = Math.min(...seqs); s <= Math.max(...seqs); s++) if (!seqs.includes(s)) missing.push(s);
  }
  check('SSE no duplicate events', dup === 0, `duplicates=${dup}`);
  check('SSE no missing events', missing.length === 0, `missing=${JSON.stringify(missing.slice(0, 5))} total=${seqs.length}`);
  check('SSE terminated with final event', got.some((e) => /run\.(succeeded|failed|cancelled)/.test(e.type)));

  // ── 压测 2：双用户并发（TC-01 缩减版）──
  console.log('\n== concurrent users isolation ==');
  const [a, b] = await Promise.all([
    sendMsg(admin, `用户A的特征码 ALPHA-${stamp}`, `iso-a-${stamp}`),
    sendMsg(demo, `用户B的特征码 BRAVO-${stamp}`, `iso-b-${stamp}`),
  ]);
  const [ra, rb] = await Promise.all([
    collectSSE(admin, a.runId),
    collectSSE(demo, b.runId),
  ]);
  const aText = ra.events.map((e) => e.payload?.delta || '').join('');
  const bText = rb.events.map((e) => e.payload?.delta || '').join('');
  check('run A completed', ra.events.some((e) => e.type === 'run.succeeded'));
  check('run B completed', rb.events.some((e) => e.type === 'run.succeeded'));
  check('A stream has no BRAVO marker', !aText.includes('BRAVO'));
  check('B stream has no ALPHA marker', !bText.includes('ALPHA'));
  // 越权：demo 访问 admin 的 run
  const cross = await fetch(`${BASE}/api/runs/${a.runId}/events`, {
    headers: { cookie: demo, origin: BASE },
  });
  check('cross-user SSE rejected', cross.status === 404 || cross.status === 403, `status=${cross.status}`);
  await cross.body?.cancel?.();

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('STRESS ERROR:', e.message);
  process.exit(1);
});
