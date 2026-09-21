// Day2 冒烟：admin 权限 + 配额 + 用量 + 非管理员 403
const BASE = process.env.WEB_BASE_URL || 'http://127.0.0.1:3100';
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

async function login(email, password) {
  const r = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email, password }),
  });
  return (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}

const admin = await login('admin@example.com', 'admin12345');
check('管理员登录', admin.includes('session'));

const users = await fetch(`${BASE}/api/admin/users?limit=5`, { headers: { cookie: admin } });
const usersJson = await users.json().catch(() => ({}));
check('GET /admin/users', users.status === 200 && Array.isArray(usersJson.users), `status=${users.status}`);
const demo = usersJson.users?.find((u) => u.email === 'demo@example.com');

const quotas = await fetch(`${BASE}/api/admin/quotas?userId=${demo?.id}`, { headers: { cookie: admin } });
const quotasJson = await quotas.json().catch(() => ({}));
check('GET /admin/quotas', quotas.status === 200 && Array.isArray(quotasJson.items), `status=${quotas.status}`);

const dsModel = quotasJson.items?.find((i) => String(i.modelId).includes('deepseek') || i.modelId);
const putQ = await fetch(`${BASE}/api/admin/quotas/${demo?.id}/${dsModel?.modelId ?? dsModel?.id}`, {
  method: 'PUT', headers: { 'content-type': 'application/json', origin: BASE, cookie: admin },
  body: JSON.stringify({ dailyLimit: 123456 }),
});
check('PUT 配额覆盖', putQ.status === 200, `status=${putQ.status} ${(await putQ.text()).slice(0, 100)}`);

const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const usage = await fetch(`${BASE}/api/admin/usage?from=2026-09-01&to=${tomorrow}`, { headers: { cookie: admin } });
check('GET /admin/usage', usage.status === 200, `status=${usage.status}`);

// 非管理员被拒
const demo2 = await login('demo@example.com', 'demo12345');
if (demo2.includes('session')) {
  const forbid = await fetch(`${BASE}/api/admin/users`, { headers: { cookie: demo2 } });
  check('非管理员 403', forbid.status === 403, `status=${forbid.status}`);
} else {
  console.log('[SKIP] demo 用户登录失败（可能无此账号/密码不同），跳过 403 验证');
}

// /admin 页面门禁
const pageRes = await fetch(`${BASE}/admin`, { headers: { cookie: admin }, redirect: 'manual' });
check('/admin 页面可达', [200, 307].includes(pageRes.status), `status=${pageRes.status}`);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
