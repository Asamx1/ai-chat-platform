// 活链烟囱：登录 → 取模型列表 → 发消息 → SSE 流式回复 → 停止
// Usage: node tests/live-chat-smoke.mjs  (前置: :3100 生产服务已起, seed 已跑, Ollama qwen3:0.6b 在线)
const BASE = process.env.WEB_BASE_URL || 'http://127.0.0.1:3100';
const EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@example.com';
const PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'admin12345';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: BASE },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const cookie = (signIn.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
check('登录', signIn.status === 200 && cookie.includes('session'), `status=${signIn.status}`);

const modelsRes = await fetch(`${BASE}/api/models`, { headers: { cookie } });
check('/api/models 鉴权可用', modelsRes.status === 200, `status=${modelsRes.status}`);
const { models } = await modelsRes.json();
const local = models.find((m) => m.kind === 'local' && m.available);
check('本地模型可用', !!local, local ? `${local.id} (${local.label})` : JSON.stringify(models));

const sendRes = await fetch(`${BASE}/api/chat/send`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: BASE, cookie },
  body: JSON.stringify({ content: '用三个字回答：你好', modelKey: local?.id ?? 'qwen3:0.6b', idempotencyKey: `smoke-${Date.now()}` }),
});
check('chat/send 受理', sendRes.status === 200, `status=${sendRes.status} ${sendRes.status !== 200 ? await sendRes.text() : ''}`);
const sendJson = sendRes.status === 200 ? await sendRes.json() : {};
const runId = sendJson.runId;
check('拿到 runId', !!runId, runId ?? JSON.stringify(sendJson));

let tokens = 0, stages = 0, done = false, firstDelta = '';
if (runId) {
  const evRes = await fetch(`${BASE}/api/runs/${runId}/events`, { headers: { cookie, accept: 'text/event-stream' } });
  check('events 流建立', evRes.status === 200, `status=${evRes.status}`);
  if (evRes.status === 200 && evRes.body) {
    const reader = evRes.body.getReader();
    const dec = new TextDecoder();
    const deadline = Date.now() + 60000;
    let buf = '';
    while (Date.now() < deadline && !done) {
      const { value, done: eof } = await reader.read();
      if (eof) break;
      buf += dec.decode(value, { stream: true });
      const events = buf.split('\n\n'); buf = events.pop() ?? '';
      for (const ev of events) {
        const line = ev.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        try {
          const j = JSON.parse(line.slice(5));
          if (j.type === 'provider.delta' && j.payload?.delta) { tokens++; if (!firstDelta) firstDelta = j.payload.delta; }
          if (j.type?.startsWith('run.') || j.type?.startsWith('orchestrator.')) stages++;
          if (['run.succeeded','run.failed','run.cancelled'].includes(j.type)) done = true;
        } catch { /* 半包忽略 */ }
      }
    }
  }
}
check('SSE 收到 token 事件', tokens > 0, `tokens=${tokens} first="${firstDelta}" stages=${stages}`);
check('SSE 正常收尾', done, '');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
