// RAG 活链冒烟：登录 → 建库传文档 → 轮询 READY → 挂载会话 → 提问验证检索注入
// 前置: :3100 生产服务 + worker(kb 队列) + Ollama bge-m3 在线
const BASE = process.env.WEB_BASE_URL || 'http://127.0.0.1:3100';
const EMAIL = 'admin@example.com';
const PASSWORD = 'admin12345';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const cookie = (signIn.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
check('登录', signIn.status === 200 && cookie.includes('session'));

// 知识内容：独特事实，模型不可能凭空知道
const SECRET = '紫晶计划的核心算法代号是「星轨-47」，2026 年由回声实验室提出。';
const docContent = `# 机密技术备忘录\n\n${SECRET}\n\n该算法用于多智能体协作的信用分配。\n`;

// 上传（先试 multipart，按 arch §4 实际契约）
const fd = new FormData();
fd.append('name', '回声实验室备忘录');
fd.append('file', new Blob([docContent], { type: 'text/markdown' }), 'memo.md');
const upRes = await fetch(`${BASE}/api/kb`, { method: 'POST', headers: { cookie }, body: fd });
const upText = await upRes.text();
check('上传知识库', [200, 201, 202].includes(upRes.status), `status=${upRes.status} ${upText.slice(0, 120)}`);
let kbId = null;
try { kbId = JSON.parse(upText).id ?? JSON.parse(upText).knowledgeBase?.id ?? JSON.parse(upText).kbId; } catch {}

// 轮询 READY（kb-worker 异步解析）
let status = 'PENDING';
const deadline = Date.now() + 120000;
while (kbId && Date.now() < deadline) {
  const r = await fetch(`${BASE}/api/kb/${kbId}`, { headers: { cookie } });
  if (r.status === 200) {
    const j = await r.json();
    const docs = j.documents ?? [];
    status = docs[0]?.status ?? j.status ?? 'PENDING';
    if (status === 'READY' || status === 'FAILED') break;
  }
  await new Promise((r2) => setTimeout(r2, 3000));
}
check('解析到 READY', status === 'READY', `status=${status}`);

// 建会话并挂载
const convRes = await fetch(`${BASE}/api/conversations`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie },
  body: JSON.stringify({ title: 'RAG 冒烟', type: 'SINGLE' }),
});
const convJson = await convRes.json().catch(() => ({}));
const convId = convJson.id ?? convJson.conversation?.id;
check('建会话', !!convId, convId ?? `status=${convRes.status}`);

const mountRes = await fetch(`${BASE}/api/conversations/${convId}/kb`, {
  method: 'PUT', headers: { 'content-type': 'application/json', origin: BASE, cookie },
  body: JSON.stringify({ kbIds: [kbId] }),
});
check('挂载知识库', mountRes.status === 200 || mountRes.status === 204, `status=${mountRes.status}`);

// 提问秘密问题
const sendRes = await fetch(`${BASE}/api/chat/send`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie },
  body: JSON.stringify({ conversationId: convId, content: '星轨-47 是什么组织的什么计划的核心算法代号？', modelKey: 'qwen3:0.6b', idempotencyKey: `rag-${Date.now()}` }),
});
const sendJson = sendRes.status === 200 ? await sendRes.json() : {};
check('发送受理', sendRes.status === 200, `status=${sendRes.status}`);

// 读事件流收答案
let answer = '';
if (sendJson.runId) {
  const evRes = await fetch(`${BASE}/api/runs/${sendJson.runId}/events`, { headers: { cookie, accept: 'text/event-stream' } });
  const reader = evRes.body.getReader();
  const dec = new TextDecoder();
  const dl = Date.now() + 90000;
  let buf = '', done = false;
  while (Date.now() < dl && !done) {
    const { value, done: eof } = await reader.read();
    if (eof) break;
    buf += dec.decode(value, { stream: true });
    const evs = buf.split('\n\n'); buf = evs.pop() ?? '';
    for (const ev of evs) {
      const line = ev.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        const j = JSON.parse(line.slice(5));
        if (j.type === 'provider.delta') answer += j.payload?.delta ?? '';
        if (['run.succeeded', 'run.failed', 'run.cancelled'].includes(j.type)) done = true;
      } catch {}
    }
  }
}
check('回答引用知识库内容', answer.includes('星轨') || answer.includes('回声') || answer.includes('紫晶'), `answer="${answer.slice(0, 80)}"`);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
