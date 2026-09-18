// M1 availability smoke test for ai-chat-platform.
// run_only_if: requires the dev server (pnpm dev) to be running.
// Usage: node tests/smoke-db.mjs
// Env:
//   WEB_BASE_URL default http://localhost:3000
// Checks (HTTP only, no direct DB access):
//   1. POST /api/auth/sign-in/email with a bogus account -> non-200 (auth routes alive)
//   2. GET /api/health -> 200
//   3. GET / -> 200 and HTML mentions 'ai-chat-platform' or 'M1'

const BASE = process.env.WEB_BASE_URL || 'http://localhost:3000';

let failures = 0;

function check(label, cond, detail = '') {
  const status = cond ? 'PASS' : 'FAIL';
  if (!cond) failures += 1;
  console.log(`[${status}] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  console.log(`smoke-db: BASE=${BASE}`);
  console.log('run_only_if: dev server must be running (pnpm dev in repo/)');

  // 1. Auth route liveness: invalid credentials must not return 200
  const bad = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'no-such-user@example.com', password: 'irrelevant' }),
  });
  check('auth route rejects unknown account (non-200)', bad.status !== 200, `status=${bad.status}`);

  // 2. Health endpoint
  const health = await fetch(`${BASE}/api/health`);
  check('GET /api/health returns 200', health.status === 200, `status=${health.status}`);

  // 3. Landing page serves HTML mentioning the project
  const home = await fetch(`${BASE}/`);
  const html = await home.text();
  check('GET / returns 200', home.status === 200, `status=${home.status}`);
  check(
    "landing HTML mentions 'ai-chat-platform' or 'M1'",
    /ai-chat-platform|M1/i.test(html),
    `match=${/ai-chat-platform|M1/i.test(html)}`
  );

  if (failures > 0) {
    console.error(`smoke-db: ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('smoke-db: all assertions passed');
}

main().catch((err) => {
  console.error('smoke-db: unexpected error —', err && err.message ? err.message : err);
  process.exit(1);
});
